import { execFile } from 'node:child_process' // @subprocess-ok: workspace git operations
import { cp, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { RunStatus, WorkspaceConfig, WorkspaceHandle } from './types.js'

const execFileAsync = promisify(execFile)
const DEFAULT_PERSISTENT_BASE = join(homedir(), '.skelm', 'workspaces')
const DEFAULT_STALE_AFTER_MS = 60_000
const DEFAULT_WAIT_TIMEOUT_MS = 5_000
const DEFAULT_POLL_INTERVAL_MS = 100
const METADATA_PATH = join('.skelm', 'workspace.json')
const LOCK_PATH = join('.skelm', 'workspace.lock')

export interface WorkspaceMetadata {
  readonly version: 1
  readonly pipelineId: string
  readonly mode: WorkspaceConfig['mode']
  readonly name?: string
  readonly createdAt: number
  readonly lastAccessAt: number
}

export interface WorkspaceManagerOptions {
  readonly persistentBase?: string
  readonly ephemeralBase?: string
  readonly staleAfterMs?: number
  readonly waitTimeoutMs?: number
  readonly pollIntervalMs?: number
}

export interface WorkspaceSummary {
  readonly pipelineId: string
  readonly name: string
  readonly path: string
  readonly lastAccessAt: number
  readonly locked: boolean
  readonly metadata: WorkspaceMetadata
}

export interface PreparedWorkspace {
  readonly handle: WorkspaceHandle
  readonly exposeAfterStep: boolean
  finishStep(stepStatus: 'completed' | 'failed' | 'cancelled'): Promise<void>
  finishRun(runStatus: RunStatus): Promise<void>
}

export class WorkspaceManager {
  constructor(private readonly options: WorkspaceManagerOptions = {}) {}

  async prepare(params: {
    pipelineId: string
    runId: string
    workspace: WorkspaceConfig
  }): Promise<PreparedWorkspace> {
    switch (params.workspace.mode) {
      case 'persistent':
        return await this.preparePersistent(params.pipelineId, params.workspace)
      case 'ephemeral':
        return await this.prepareEphemeral(params.pipelineId, params.runId, params.workspace)
      case 'mounted':
        return await this.prepareMounted(params.pipelineId, params.workspace)
    }
  }

  async listPersistentWorkspaces(): Promise<readonly WorkspaceSummary[]> {
    const base = resolvePath(this.options.persistentBase ?? DEFAULT_PERSISTENT_BASE)
    try {
      const pipelines = await readdir(base)
      const summaries: WorkspaceSummary[] = []
      for (const pipelineId of pipelines) {
        const pipelinePath = join(base, pipelineId)
        const workspaceNames = await readdir(pipelinePath)
        for (const name of workspaceNames) {
          const path = join(pipelinePath, name)
          const metadata = await readMetadata(path)
          if (!metadata) continue
          summaries.push({
            pipelineId,
            name,
            path,
            lastAccessAt: metadata.lastAccessAt,
            locked: await exists(join(path, LOCK_PATH)),
            metadata,
          })
        }
      }
      return summaries.sort((a, b) => b.lastAccessAt - a.lastAccessAt)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  async getPersistentWorkspace(pipelineId: string, name: string): Promise<WorkspaceSummary | null> {
    const path = this.persistentPath(pipelineId, name)
    const metadata = await readMetadata(path)
    if (!metadata) return null
    return {
      pipelineId,
      name,
      path,
      lastAccessAt: metadata.lastAccessAt,
      locked: await exists(join(path, LOCK_PATH)),
      metadata,
    }
  }

  async cleanPersistentWorkspace(pipelineId: string, name: string): Promise<void> {
    await rm(this.persistentPath(pipelineId, name), { recursive: true, force: true })
  }

  private async preparePersistent(
    pipelineId: string,
    workspace: Extract<WorkspaceConfig, { mode: 'persistent' }>,
  ): Promise<PreparedWorkspace> {
    const base = resolvePath(
      workspace.base ?? this.options.persistentBase ?? DEFAULT_PERSISTENT_BASE,
    )
    const path = join(base, pipelineId, workspace.name)
    await mkdir(join(path, '.skelm'), { recursive: true })
    const release = await acquireLock(join(path, LOCK_PATH), this.options)
    const metadata = await touchMetadata(path, {
      pipelineId,
      mode: 'persistent',
      name: workspace.name,
    })
    if (workspace.gitRoot) {
      await ensureGitRoot(path)
    }
    const handle: WorkspaceHandle = Object.freeze({
      path,
      mode: 'persistent',
      name: workspace.name,
    })
    let released = false
    return {
      handle,
      exposeAfterStep: true,
      async finishStep(): Promise<void> {
        if (released) return
        released = true
        await release()
      },
      async finishRun(runStatus: RunStatus): Promise<void> {
        await writeMetadata(path, {
          ...metadata,
          lastAccessAt: Date.now(),
        })
        if (workspace.cleanup === 'on-success' && runStatus === 'completed') {
          await rm(path, { recursive: true, force: true })
        }
      },
    }
  }

  private async prepareEphemeral(
    pipelineId: string,
    runId: string,
    workspace: Extract<WorkspaceConfig, { mode: 'ephemeral' }>,
  ): Promise<PreparedWorkspace> {
    const base = resolvePath(this.options.ephemeralBase ?? tmpdir())
    await mkdir(base, { recursive: true })
    const prefix = workspace.prefix ?? `${pipelineId}-${runId}-`
    const cleanup = workspace.cleanup ?? 'on-run-end'
    const path = await mkdtemp(join(base, prefix))
    await mkdir(join(path, '.skelm'), { recursive: true })
    // Seed: copy files/dirs into the workspace before the step runs
    if (workspace.seed?.copy) {
      await seedWorkspace(path, workspace.seed.copy)
    }
    const metadata = await touchMetadata(path, {
      pipelineId,
      mode: 'ephemeral',
    })
    return {
      handle: Object.freeze({
        path,
        mode: 'ephemeral',
      }),
      exposeAfterStep: cleanup !== 'on-step-end',
      async finishStep(): Promise<void> {
        if (cleanup === 'on-step-end') {
          await rm(path, { recursive: true, force: true })
        }
      },
      async finishRun(runStatus: RunStatus): Promise<void> {
        if (cleanup === 'on-step-end') {
          return
        }
        if (cleanup === 'on-run-end') {
          await rm(path, { recursive: true, force: true })
          return
        }
        if (cleanup === 'on-success' && runStatus === 'completed') {
          await rm(path, { recursive: true, force: true })
          return
        }
        await writeMetadata(path, { ...metadata, lastAccessAt: Date.now() })
      },
    }
  }

  private async prepareMounted(
    _pipelineId: string,
    workspace: Extract<WorkspaceConfig, { mode: 'mounted' }>,
  ): Promise<PreparedWorkspace> {
    const path = resolvePath(workspace.path)
    const info = await stat(path)
    if (!info.isDirectory()) {
      throw new Error(`mounted workspace path is not a directory: ${path}`)
    }
    return {
      handle: Object.freeze({
        path,
        mode: 'mounted',
      }),
      exposeAfterStep: true,
      async finishStep(): Promise<void> {},
      async finishRun(): Promise<void> {},
    }
  }

  private persistentPath(pipelineId: string, name: string): string {
    const base = resolvePath(this.options.persistentBase ?? DEFAULT_PERSISTENT_BASE)
    return join(base, pipelineId, name)
  }
}

async function ensureGitRoot(path: string): Promise<void> {
  if (await exists(join(path, '.git'))) return
  await execFileAsync('git', ['init'], { cwd: path })
}

async function touchMetadata(
  path: string,
  data: Pick<WorkspaceMetadata, 'pipelineId' | 'mode' | 'name'>,
): Promise<WorkspaceMetadata> {
  const existing = await readMetadata(path)
  const now = Date.now()
  const metadata: WorkspaceMetadata = {
    version: 1,
    createdAt: existing?.createdAt ?? now,
    lastAccessAt: now,
    ...data,
  }
  await writeMetadata(path, metadata)
  return metadata
}

async function readMetadata(path: string): Promise<WorkspaceMetadata | null> {
  try {
    const raw = await readFile(join(path, METADATA_PATH), 'utf8')
    return JSON.parse(raw) as WorkspaceMetadata
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function writeMetadata(path: string, metadata: WorkspaceMetadata): Promise<void> {
  const target = join(path, METADATA_PATH)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
}

async function acquireLock(
  path: string,
  options: WorkspaceManagerOptions,
): Promise<() => Promise<void>> {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const startedAt = Date.now()

  while (true) {
    try {
      await mkdir(dirname(path), { recursive: true })
      const file = await open(path, 'wx')
      await file.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`)
      await file.close()
      return async () => {
        await rm(path, { force: true })
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      if (await isStale(path, staleAfterMs)) {
        await rm(path, { force: true })
        continue
      }
      if (Date.now() - startedAt >= waitTimeoutMs) {
        throw new Error(`workspace lock timed out: ${path}`)
      }
      await sleep(pollIntervalMs)
    }
  }
}

async function isStale(path: string, staleAfterMs: number): Promise<boolean> {
  try {
    const info = await stat(path)
    return Date.now() - info.mtimeMs > staleAfterMs
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function resolvePath(path: string): string {
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2))
  }
  return resolve(path)
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Copy each path in `sources` into `destDir`.
 * Directories are copied recursively; files are copied to the same basename.
 * Paths are resolved relative to `process.cwd()`.
 */
async function seedWorkspace(destDir: string, sources: readonly string[]): Promise<void> {
  for (const src of sources) {
    const abs = resolve(src)
    let srcStat: Awaited<ReturnType<typeof stat>> | null = null
    try {
      srcStat = await stat(abs)
    } catch {
      // Skip missing sources silently — seed is best-effort
      continue
    }
    const name = basename(abs)
    const dest = join(destDir, name)
    if (srcStat.isDirectory()) {
      await cp(abs, dest, { recursive: true, force: true })
    } else {
      await mkdir(dirname(dest), { recursive: true })
      await cp(abs, dest, { force: true })
    }
  }
}
