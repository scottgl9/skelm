import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { WorkflowRegistrationError } from './workflow-registration-service.js'

const EXCLUDED_DIRS = new Set(['.git', '.skelm', 'node_modules', 'coverage', 'dist'])

export interface WorkflowArtifactOptions {
  artifactRoot: string
  maxBytes: number
}

export interface MaterializeTreeInput {
  id: string
  sourceRoot: string
  entryPath: string
  originPath?: string
  configPath?: string
}

export interface MaterializedWorkflowArtifact {
  artifactDir: string
  entryPath: string
  originPath?: string
  configPath?: string
}

/**
 * Copies trusted workflow source trees into gateway-owned storage. The managed
 * copy is what later runs import and what future source-edit routes may mutate.
 */
export class WorkflowArtifactService {
  constructor(private readonly options: WorkflowArtifactOptions) {}

  get artifactRoot(): string {
    return this.options.artifactRoot
  }

  async materializeTree(input: MaterializeTreeInput): Promise<MaterializedWorkflowArtifact> {
    const sourceRoot = await realpath(input.sourceRoot)
    const entryPath = await realpath(input.entryPath)
    assertWithin(entryPath, sourceRoot, 'entry path')
    const configPath =
      input.configPath !== undefined && input.configPath.length > 0
        ? await realpath(input.configPath)
        : undefined
    if (configPath !== undefined) assertWithin(configPath, sourceRoot, 'config path')

    const artifactDir = this.destinationFor(input.id)
    const parentDir = this.parentFor(input.id)
    const staging = `${artifactDir}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const bytes = { total: 0 }
    try {
      await mkdir(parentDir, { recursive: true })
      await copyTree(sourceRoot, staging, this.options.maxBytes, bytes)
      await symlinkNearestNodeModules(sourceRoot, staging)
      await rm(artifactDir, { recursive: true, force: true })
      await rename(staging, artifactDir)
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw err
    }

    const entryRel = relative(sourceRoot, entryPath)
    const configRel = configPath === undefined ? undefined : relative(sourceRoot, configPath)
    return {
      artifactDir,
      entryPath: join(artifactDir, entryRel),
      ...(input.originPath !== undefined && { originPath: input.originPath }),
      ...(configRel !== undefined && { configPath: join(artifactDir, configRel) }),
    }
  }

  async remove(id: string): Promise<void> {
    await rm(this.parentFor(id), { recursive: true, force: true })
  }

  destinationFor(id: string): string {
    return join(this.parentFor(id), 'current')
  }

  private parentFor(id: string): string {
    return join(this.options.artifactRoot, encodeURIComponent(id))
  }
}

async function copyTree(
  source: string,
  dest: string,
  maxBytes: number,
  bytes: { total: number },
): Promise<void> {
  const stat = await lstat(source)
  if (stat.isSymbolicLink()) {
    throw new WorkflowRegistrationError(400, `workflow source contains symbolic link: ${source}`)
  }
  if (stat.isDirectory()) {
    await mkdir(dest, { recursive: true })
    for (const name of await readdir(source)) {
      if (EXCLUDED_DIRS.has(name)) continue
      await copyTree(join(source, name), join(dest, name), maxBytes, bytes)
    }
    return
  }
  if (!stat.isFile()) return
  bytes.total += stat.size
  if (bytes.total > maxBytes) {
    throw new WorkflowRegistrationError(
      413,
      `workflow source tree exceeds maximum size of ${maxBytes} bytes`,
    )
  }
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, await readFile(source))
}

async function symlinkNearestNodeModules(sourceRoot: string, artifactDir: string): Promise<void> {
  const sourceNodeModules = await findNearestNodeModules(sourceRoot)
  if (sourceNodeModules === undefined) return
  await symlink(sourceNodeModules, join(artifactDir, 'node_modules'))
}

async function findNearestNodeModules(sourceRoot: string): Promise<string | undefined> {
  let dir = sourceRoot
  for (;;) {
    const candidate = join(dir, 'node_modules')
    try {
      const stat = await lstat(candidate)
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        return await realpath(candidate)
      }
    } catch {
      // keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function assertWithin(target: string, root: string, label: string): void {
  const normRoot = root.endsWith(sep) ? root : `${root}${sep}`
  if (target !== root && !target.startsWith(normRoot)) {
    throw new WorkflowRegistrationError(400, `${label} is outside the workflow source root`)
  }
}
