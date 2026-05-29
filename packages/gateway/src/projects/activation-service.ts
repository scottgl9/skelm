import { readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  BackendRegistry,
  CONFIG_FILENAMES,
  type SkelmConfig,
  isPersistentWorkflow,
  pickExport,
} from '@skelm/core'

import type { Gateway } from '../lifecycle/gateway.js'
import { pipelineTriggerToSpec } from '../triggers/pipeline-trigger-to-spec.js'
import { WorkflowRegistrationError } from '../workflows/workflow-registration-service.js'

const WORKFLOW_RE = /\.(?:workflow|pipeline)\.m?ts$/

export class ProjectActivationError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'ProjectActivationError'
  }
}

export interface ActivatedWorkflow {
  id: string
  path: string
  kind: 'persistent-workflow' | 'pipeline'
}

export interface ActivatedTrigger {
  id: string
  kind: string
  driver?: string
  armed: boolean
  lastError?: string
}

export interface ActivationResult {
  project: { dir: string; configPath: string | null }
  trusted: boolean
  workflows: ActivatedWorkflow[]
  triggers: ActivatedTrigger[]
  backends: { absorbed: string[]; skipped: string[] }
  grants: { absorbed: string[]; refused: string[] }
  agentmemory: 'adopted' | 'already-set' | 'skipped'
  refresh: boolean
  message?: string
}

/**
 * Owns runtime project activation: `skelm run <dir>` for a triggered/persistent
 * project lands here via POST /v1/projects/activate. The gateway dynamically
 * imports the dir's skelm.config.* in its own process (the trigger-source
 * drivers and backend instances are live objects that cannot cross HTTP),
 * registers its queue drivers, absorbs its backends, registers its workflow
 * files, arms their declared triggers, and merges its unrestrictedGrants +
 * agentmemory into the running config.
 *
 * SECURITY (top tenet): a dir outside the gateway's trusted registration roots
 * is refused wholesale BEFORE its config is imported — importing runs arbitrary
 * top-level code as the gateway user, and grants/backends are an escalation. The
 * path-gate reuses WorkflowRegistrationService.resolveSourcePath verbatim.
 */
export class ProjectActivationService {
  /** Realpath'd dirs activated this gateway lifetime — a re-run is a refresh. */
  private readonly active = new Set<string>()

  constructor(private readonly gateway: Gateway) {}

  list(): string[] {
    return [...this.active]
  }

  async activate(dir: string): Promise<ActivationResult> {
    if (typeof dir !== 'string' || dir.length === 0) {
      throw new ProjectActivationError(400, 'dir is required')
    }
    let realDir: string
    try {
      realDir = await realpath(resolve(dir))
    } catch {
      throw new ProjectActivationError(404, `directory not found: ${dir}`)
    }

    const configPath = await findConfig(realDir)
    if (configPath === undefined) {
      throw new ProjectActivationError(400, `no skelm.config.* found in ${realDir}`)
    }

    // Path-gate before importing: an untrusted dir is inert. Reuses the
    // registration service's realpath-containment check.
    const trusted = await this.isTrusted(realDir)
    if (!trusted) {
      return {
        project: { dir: realDir, configPath },
        trusted: false,
        workflows: [],
        triggers: [],
        backends: { absorbed: [], skipped: [] },
        grants: { absorbed: [], refused: [] },
        agentmemory: 'skipped',
        refresh: false,
        message: `${realDir} is outside the gateway's trusted projectRoot/allowedRegistrationDirs; refusing to import, register, escalate grants, or absorb backends. Start the gateway under this project, or add it to allowedRegistrationDirs.`,
      }
    }

    let dirConfig: SkelmConfig
    try {
      const mod = (await import(pathToFileURL(configPath).href)) as Record<string, unknown>
      dirConfig = pickExport(mod, 'default') as SkelmConfig
    } catch (err) {
      throw new ProjectActivationError(
        400,
        `failed to import ${configPath}: ${(err as Error).message}`,
      )
    }
    if (typeof dirConfig !== 'object' || dirConfig === null) {
      throw new ProjectActivationError(400, `${configPath} did not default-export a config object`)
    }

    const refresh = this.active.has(realDir)

    // 1. Queue drivers (live objects from the imported config).
    for (const entry of dirConfig.triggerSources ?? []) {
      this.gateway.managers.triggers.registerQueueDriver(entry.id, entry.driver)
    }

    // 2. Register workflow files under their declared id (the id grants and
    //    sessions key on), arming their declared triggers.
    const workflows: ActivatedWorkflow[] = []
    const triggers: ActivatedTrigger[] = []
    const service = this.gateway.getWorkflowRegistrationService()
    for (const file of await discoverWorkflowFiles(realDir, dirConfig)) {
      let wf: { id?: unknown; triggers?: readonly Record<string, unknown>[] } | undefined
      try {
        const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
        wf = pickExport(mod, 'default') as typeof wf
      } catch (err) {
        throw new ProjectActivationError(400, `failed to import ${file}: ${(err as Error).message}`)
      }
      if (wf === undefined || typeof wf.id !== 'string') continue
      const id = wf.id
      const real = await service.resolveSourcePath(file)
      await service.upsert({ id, sourcePath: real, sourceKind: 'path' })
      workflows.push({
        id,
        path: real,
        kind: isPersistentWorkflow(wf) ? 'persistent-workflow' : 'pipeline',
      })
      for (const [i, t] of (wf.triggers ?? []).entries()) {
        triggers.push(this.armTrigger(id, t, i))
      }
    }

    // 3. Absorb backend instances (live objects).
    const incoming = new BackendRegistry()
    for (const backend of dirConfig.instances ?? []) incoming.registerIfAbsent(backend)
    const backends = this.gateway.absorbBackends(incoming)

    // 4. Merge grants + agentmemory into the running config, then reload so
    //    enforcement sees the new grant set.
    const current = this.gateway.getConfig()
    const currentGrants = current.defaults?.unrestrictedGrants ?? []
    const incomingGrants = dirConfig.defaults?.unrestrictedGrants ?? []
    const grantsAbsorbed = incomingGrants.filter((g) => !currentGrants.includes(g))
    const agentmemory: ActivationResult['agentmemory'] =
      current.agentmemory !== undefined
        ? dirConfig.agentmemory !== undefined
          ? 'already-set'
          : 'skipped'
        : dirConfig.agentmemory !== undefined
          ? 'adopted'
          : 'skipped'

    const nextConfig: SkelmConfig = {
      ...current,
      defaults: {
        ...current.defaults,
        unrestrictedGrants: [...currentGrants, ...grantsAbsorbed],
      },
      ...(agentmemory === 'adopted' && { agentmemory: dirConfig.agentmemory }),
    }
    await this.gateway.reload(nextConfig)
    if (agentmemory === 'adopted') await this.gateway.reinitAgentmemory()

    this.active.add(realDir)

    return {
      project: { dir: realDir, configPath },
      trusted: true,
      workflows,
      triggers,
      backends,
      grants: { absorbed: grantsAbsorbed, refused: [] },
      agentmemory,
      refresh,
    }
  }

  private async isTrusted(dir: string): Promise<boolean> {
    try {
      await this.gateway.getWorkflowRegistrationService().resolveSourcePath(dir)
      return true
    } catch (err) {
      if (err instanceof WorkflowRegistrationError) return false
      throw err
    }
  }

  /** Register (idempotently) one declared trigger and report its armed state. */
  private armTrigger(
    workflowId: string,
    t: Record<string, unknown>,
    index: number,
  ): ActivatedTrigger {
    const spec = pipelineTriggerToSpec(workflowId, t, index)
    if (spec === undefined) {
      return {
        id: `${workflowId}#${(t.kind as string | undefined) ?? 'trigger'}`,
        kind: (t.kind as string | undefined) ?? 'unknown',
        armed: false,
        lastError: 'unsupported or refused trigger configuration',
      }
    }
    const driver = spec.kind === 'queue' ? spec.driver : undefined
    const existing = this.gateway.managers.triggers.get(spec.id)
    if (existing !== undefined) {
      return {
        id: spec.id,
        kind: spec.kind,
        ...(driver !== undefined && { driver }),
        armed: existing.lastError === undefined,
        ...(existing.lastError !== undefined && { lastError: existing.lastError }),
      }
    }
    const reg = this.gateway.managers.triggers.register(spec, undefined, {
      ...(t.input !== undefined && { input: t.input }),
      declared: true,
    })
    return {
      id: spec.id,
      kind: spec.kind,
      ...(driver !== undefined && { driver }),
      armed: reg.lastError === undefined,
      ...(reg.lastError !== undefined && { lastError: reg.lastError }),
    }
  }
}

async function findConfig(dir: string): Promise<string | undefined> {
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(dir, name)
    try {
      await realpath(candidate)
      return candidate
    } catch {
      // not present — try next
    }
  }
  return undefined
}

async function discoverWorkflowFiles(dir: string, config: SkelmConfig): Promise<string[]> {
  const files = new Set<string>()
  if (typeof config.entrypoint === 'string' && config.entrypoint.length > 0) {
    files.add(resolve(dir, config.entrypoint))
  }
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    names = []
  }
  for (const name of names) {
    if (WORKFLOW_RE.test(name)) files.add(join(dir, name))
  }
  return [...files]
}
