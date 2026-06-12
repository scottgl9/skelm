import { readdir, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  BackendRegistry,
  CONFIG_FILENAMES,
  PERSISTENT_WORKFLOW_NAMESPACE,
  type PersistentSessionRecord,
  type SkelmConfig,
  isPersistentWorkflow,
  pickExport,
} from '@skelm/core'

import type { GatewayContext } from '../lifecycle/gateway-types.js'
import {
  loadManagedConfig,
  materializePathWorkflow,
  projectArtifactId,
} from '../workflows/path-materialization.js'
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

export interface TriggerView {
  id: string
  workflowId: string
  kind: string
  driver?: string
  fired: number
  lastFiredAt?: string
  inflight: boolean
  lastError?: string
}

export interface RunningRun {
  runId: string
  pipelineId: string
  triggerId?: string
  status: string
  startedAt: number
}

export interface ActiveView {
  persistentWorkflows: {
    workflowId: string
    triggers: TriggerView[]
    sessions: { count: number; lastUpdatedAt: number | null }
  }[]
  triggers: TriggerView[]
  runsInFlight: RunningRun[]
}

export interface DeactivationResult {
  deactivated: true
  id: string
  triggersRemoved: string[]
  runsCancelled: string[]
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
  /** Declared ids of persistent workflows activated this lifetime, so the
   *  running view lists them before their first fire sets `parallel`. */
  private readonly persistentIds = new Set<string>()
  /** workflowId → project dir, so deactivate can clear its per-workflow
   *  permission ceiling and other per-project bookkeeping. */
  private readonly workflowProjectDirs = new Map<string, string>()
  /** project dir → managed config artifact id, for activation/deactivation cleanup. */
  private readonly projectConfigArtifacts = new Map<string, string>()

  constructor(private readonly gateway: GatewayContext) {}

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

    const configArtifactId = projectArtifactId(realDir)
    const managedConfig = await materializePathWorkflow(this.gateway, {
      id: configArtifactId,
      path: configPath,
      configPath,
      sourceRoot: realDir,
    })
    this.projectConfigArtifacts.set(realDir, configArtifactId)

    let dirConfig: SkelmConfig
    try {
      dirConfig = await loadManagedConfig(managedConfig.configPath ?? managedConfig.entryPath)
    } catch (err) {
      throw new ProjectActivationError(
        400,
        `failed to import ${configPath}: ${(err as Error).message}`,
      )
    }

    const refresh = this.active.has(realDir)
    const managedProjectDir = dirname(managedConfig.configPath ?? managedConfig.entryPath)

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
        const managedFile = join(managedProjectDir, relative(realDir, file))
        const mod = (await import(pathToFileURL(managedFile).href)) as Record<string, unknown>
        wf = pickExport(mod, 'default') as typeof wf
      } catch (err) {
        throw new ProjectActivationError(400, `failed to import ${file}: ${(err as Error).message}`)
      }
      if (wf === undefined || typeof wf.id !== 'string') continue
      const id = wf.id
      const registered = await materializePathWorkflow(this.gateway, {
        id,
        path: file,
        configPath,
        sourceRoot: realDir,
      })
      await service.upsert({
        id,
        sourcePath: registered.entryPath,
        sourceKind: 'managed',
        originPath: registered.originPath,
        originKind: 'path',
      })
      const persistent = isPersistentWorkflow(wf)
      if (persistent) this.persistentIds.add(id)
      workflows.push({
        id,
        path: registered.entryPath,
        kind: persistent ? 'persistent-workflow' : 'pipeline',
      })
      // Pin the project's defaults.permissions + permissionProfiles to THIS
      // workflow id so the runtime ceiling is the project's, not whatever
      // operator-wide defaults the gateway happens to have. Keyed per
      // workflow so two activated projects don't cross-contaminate.
      this.gateway.registerWorkflowProjectPermissions(id, {
        ...(dirConfig.defaults?.permissions !== undefined && {
          defaultPermissions: dirConfig.defaults.permissions,
        }),
        ...(dirConfig.defaults?.permissionProfiles !== undefined && {
          permissionProfiles: dirConfig.defaults.permissionProfiles,
        }),
        ...(dirConfig.defaults?.executableProfiles !== undefined && {
          executableProfiles: dirConfig.defaults.executableProfiles,
        }),
      })
      // Mirror the same per-workflow scoping for backend defaults: each
      // workflow resolves agent()/infer() steps with no explicit `backend:`
      // against ITS OWN project's `config.backends.{agent,infer}`.
      const projectAgentBackend =
        typeof dirConfig.backends?.agent === 'string' ? dirConfig.backends.agent : undefined
      const projectInferBackend =
        typeof dirConfig.backends?.infer === 'string' ? dirConfig.backends.infer : undefined
      this.gateway.registerWorkflowProjectBackends(id, {
        ...(projectAgentBackend !== undefined && { defaultAgentBackend: projectAgentBackend }),
        ...(projectInferBackend !== undefined && { defaultInferBackend: projectInferBackend }),
      })
      this.workflowProjectDirs.set(id, realDir)
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

    // Only reload when the merge actually changes the running config — a new
    // grant (enforcement must be rebuilt) or an adopted agentmemory block.
    // A refresh that adds neither is a no-op; reloading would spin the registry
    // refresh + onReload cycle for nothing. Triggers and backends are wired
    // above independently of reload, so skipping it here is safe.
    if (grantsAbsorbed.length > 0 || agentmemory === 'adopted') {
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
    }

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

  /**
   * A ps-like view of what the gateway is currently running: every trigger
   * registration grouped by workflow, the persistent-workflow session counts,
   * and the in-flight runs. Backs `skelm list`.
   */
  async activeView(): Promise<ActiveView> {
    const triggers: TriggerView[] = this.gateway.managers.triggers.list().map((r) => ({
      id: r.spec.id,
      workflowId: r.spec.workflowId,
      kind: r.spec.kind,
      ...(r.spec.kind === 'queue' && { driver: r.spec.driver }),
      fired: r.fired,
      ...(r.lastFiredAt !== undefined && { lastFiredAt: r.lastFiredAt }),
      inflight: r.inflight,
      ...(r.lastError !== undefined && { lastError: r.lastError }),
    }))

    const sessions = new Map<string, { count: number; lastUpdatedAt: number }>()
    for await (const entry of this.gateway.runStore.listState(PERSISTENT_WORKFLOW_NAMESPACE)) {
      const rec = entry.value as PersistentSessionRecord
      if (typeof rec?.workflowId !== 'string') continue
      const cur = sessions.get(rec.workflowId) ?? { count: 0, lastUpdatedAt: 0 }
      cur.count += 1
      cur.lastUpdatedAt = Math.max(cur.lastUpdatedAt, rec.updatedAt ?? 0)
      sessions.set(rec.workflowId, cur)
    }

    const runsInFlight: RunningRun[] = []
    for await (const run of this.gateway.runStore.listRuns({ status: 'running' })) {
      runsInFlight.push({
        runId: run.runId,
        pipelineId: run.pipelineId,
        ...(run.triggerId !== undefined && { triggerId: run.triggerId }),
        status: run.status,
        startedAt: run.startedAt,
      })
    }

    // A workflow is "persistent" when it was activated as one, multiplexes
    // parallel fires (set on first persistent fire), or already has durable
    // sessions. The activation-time set means the list view shows a persistent
    // workflow immediately, before its first fire.
    const persistentIds = new Set<string>([...this.persistentIds, ...sessions.keys()])
    for (const r of this.gateway.managers.triggers.list()) {
      if (r.parallel === true) persistentIds.add(r.spec.workflowId)
    }
    const persistentWorkflows = [...persistentIds].map((workflowId) => {
      const s = sessions.get(workflowId)
      return {
        workflowId,
        triggers: triggers.filter((t) => t.workflowId === workflowId),
        sessions: {
          count: s?.count ?? 0,
          lastUpdatedAt: s !== undefined ? s.lastUpdatedAt : null,
        },
      }
    })

    return { persistentWorkflows, triggers, runsInFlight }
  }

  /**
   * Deactivate a workflow: unregister every trigger for it (stopping its queue
   * driver — e.g. Telegram polling halts), drop its registration so a later
   * reload does not re-arm it, and optionally cancel its in-flight turns.
   * Persisted sessions are left intact so a re-activation resumes the
   * conversation. 404 when the workflow has no live triggers.
   */
  async deactivate(
    id: string,
    opts: { cancelInflight?: boolean } = {},
  ): Promise<DeactivationResult> {
    const regs = this.gateway.managers.triggers.list().filter((r) => r.spec.workflowId === id)
    if (regs.length === 0) {
      throw new ProjectActivationError(404, `no active workflow ${id}`)
    }
    const triggersRemoved: string[] = []
    for (const r of regs) {
      this.gateway.managers.triggers.unregister(r.spec.id)
      triggersRemoved.push(r.spec.id)
    }
    await this.gateway.getWorkflowRegistrationService().remove(id)
    await this.gateway.getWorkflowArtifactService().remove(id)
    this.persistentIds.delete(id)
    this.gateway.unregisterWorkflowProjectPermissions(id)
    this.gateway.unregisterWorkflowProjectBackends(id)
    const projectDir = this.workflowProjectDirs.get(id)
    this.workflowProjectDirs.delete(id)
    if (projectDir !== undefined && ![...this.workflowProjectDirs.values()].includes(projectDir)) {
      const artifactId = this.projectConfigArtifacts.get(projectDir)
      if (artifactId !== undefined) {
        await this.gateway.getWorkflowArtifactService().remove(artifactId)
        this.projectConfigArtifacts.delete(projectDir)
      }
      this.active.delete(projectDir)
    }

    const runsCancelled: string[] = []
    if (opts.cancelInflight === true) {
      for await (const run of this.gateway.runStore.listRuns({ status: 'running' })) {
        if (run.pipelineId === id && this.gateway.cancel(run.runId, 'workflow deactivated')) {
          runsCancelled.push(run.runId)
        }
      }
    }
    return { deactivated: true, id, triggersRemoved, runsCancelled }
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
