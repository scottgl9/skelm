import {
  type AgentmemoryAuditEvent,
  type AgentmemoryClient,
  createAgentmemoryHandle,
} from '@skelm/agentmemory'
import {
  ALL_AGENTMEMORY_OPS,
  type AgentPermissions,
  type BackendRegistry,
  type EventBus,
  type ExecutableProfileDefinition,
  type NetworkPolicy,
  type Pipeline,
  type RunStore,
  Runner,
  type SkelmConfig,
  type WaitStep,
  type WorkspaceManager,
  validate,
} from '@skelm/core'
import { loadPipelineFromPath, makeGatewayPipelineRegistry } from '../http/routes/utils.js'
import type { GatewayEnforcement, GatewayRegistries } from '../lifecycle/gateway-types.js'
import { createSkillSource } from '../registries/skill-source.js'

const AGENTMEMORY_OPS = ALL_AGENTMEMORY_OPS

interface WorkflowProjectPermissions {
  defaultPermissions?: AgentPermissions
  permissionProfiles?: Readonly<Record<string, AgentPermissions>>
  executableProfiles?: Readonly<Record<string, ExecutableProfileDefinition>>
}

interface WorkflowProjectBackends {
  defaultAgentBackend?: string
  defaultInferBackend?: string
}

export interface GatewayRuntimeContext {
  readonly projectRoot: string
  readonly registries: GatewayRegistries
  readonly enforcement: GatewayEnforcement
  readonly runStore: RunStore
  readonly events: EventBus
  readonly workspaceManager: WorkspaceManager
  readonly backends: BackendRegistry | undefined
  getConfig(): SkelmConfig
  getWorkflowLoader(): ((registryId: string, absolutePath: string) => Promise<unknown>) | undefined
  attachMetricsBus(bus: EventBus): void
  attachOtelBus(bus: EventBus): void
  registerEgressToken(runId: string, stepId: string, policy: NetworkPolicy): string
  unregisterEgressToken(runId: string, stepId: string): void
  getProxyEnvVars(egressToken?: string): Record<string, string> | undefined
  getAgentmemoryClient(): AgentmemoryClient | null
}

export class GatewayRuntime {
  readonly #inFlightRuns = new Map<string, AbortController>()
  readonly #inFlightRunners = new Map<string, Runner>()
  readonly #workflowProjectPermissions = new Map<string, WorkflowProjectPermissions>()
  readonly #workflowProjectBackends = new Map<string, WorkflowProjectBackends>()

  constructor(private readonly ctx: GatewayRuntimeContext) {}

  /**
   * Register an AbortController for an in-flight run so that
   * `gateway.cancel(runId)` can abort it. The dispatcher calls this when
   * it starts a run and pairs it with `unregisterRun` once the run
   * settles.
   */
  registerRun(runId: string, controller: AbortController, runner?: Runner): void {
    this.#inFlightRuns.set(runId, controller)
    if (runner !== undefined) this.#inFlightRunners.set(runId, runner)
  }

  unregisterRun(runId: string): void {
    this.#inFlightRuns.delete(runId)
    this.#inFlightRunners.delete(runId)
  }

  /**
   * The Runner managing an in-flight run. Used by the HTTP layer to forward
   * resume() calls (POST /runs/:runId/resume) to the right Runner instance.
   * Returns undefined when the run is unknown or already completed.
   */
  getRunner(runId: string): Runner | undefined {
    return this.#inFlightRunners.get(runId)
  }

  /**
   * Shared async-start path used by `POST /pipelines/:id/start` and the batch
   * fan-out route. Constructs a Runner with the gateway's enforcement, wires
   * skills + sub-pipeline lookup, registers the run for cancellation, and
   * fires it without awaiting. Returns the registered runId; callers handle
   * idempotency and response shaping.
   *
   * Thrown errors carry a `.statusCode` so h3 surfaces them with the right
   * HTTP status (404 for unknown id, 501 when no loader is wired). Errors
   * raised by `loadPipelineFromPath` (load failure, missing default export)
   * propagate through unchanged.
   */
  async startPipelineAsync(pipelineId: string, input: unknown): Promise<{ runId: string }> {
    const entry = this.ctx.registries.workflows.get(pipelineId)
    if (entry === undefined) {
      throw startPipelineError(404, 'pipeline not found')
    }
    const loader = this.ctx.getWorkflowLoader()
    if (loader === undefined) {
      throw startPipelineError(501, 'gateway has no workflow loader')
    }
    const pipeline = await loadPipelineFromPath(loader, pipelineId, entry.path)
    const { runId } = this.#startRunnerAsync(pipeline, input, entry.path)
    return { runId }
  }

  /**
   * Async ad-hoc start by absolute workflow path. The caller (HTTP routes)
   * is responsible for validating the path against the loader trust boundary
   * before handing it here. Mirrors {@link startPipelineAsync} but for a file
   * that need not be in the workflow registry, so `POST /runs` and
   * `POST /pipelines/start-file` share one start path.
   */
  async startAdhocRunByFile(
    absolutePath: string,
    registryId: string,
    input: unknown,
  ): Promise<{ runId: string; pipelineId: string }> {
    const loader = this.ctx.getWorkflowLoader()
    if (loader === undefined) {
      throw startPipelineError(501, 'gateway has no workflow loader')
    }
    const pipeline = await loadPipelineFromPath(loader, registryId, absolutePath)
    const { runId } = this.#startRunnerAsync(pipeline, input, absolutePath)
    return { runId, pipelineId: pipeline.id }
  }

  /**
   * Resume a run that survived a gateway restart while parked at wait().
   * The original in-memory Runner is gone after restart, but the RunStore keeps
   * the workflow path, input, completed prior steps, and waiting snapshot. Build
   * a fresh Runner that starts at the waiting step and supplies the resume value.
   */
  async resumeWaitingRun(runId: string, resumeValue: unknown): Promise<void> {
    const stored = await this.ctx.runStore.getRun(runId)
    if (stored === null) {
      throw startPipelineError(
        404,
        'no in-flight runner for run (already completed, or unknown to this gateway)',
      )
    }
    if (stored.status !== 'waiting' || stored.waiting === undefined) {
      throw startPipelineError(400, `run ${runId} is not waiting`)
    }
    if (stored.workflowPath === undefined) {
      throw startPipelineError(400, `run ${runId} has no workflowPath; cannot rehydrate`)
    }
    const loader = this.ctx.getWorkflowLoader()
    if (loader === undefined) {
      throw startPipelineError(501, 'gateway has no workflow loader')
    }
    const pipeline = await loadPipelineFromPath(loader, stored.pipelineId, stored.workflowPath)
    // Validate the resume value against the waiting step's output schema BEFORE
    // starting the runner. This preserves the synchronous rejection contract for
    // invalid resume payloads after restart, rather than accepting then failing
    // asynchronously inside the pipeline.
    const waitingStepId = stored.waiting.stepId
    const waitingStep = pipeline.steps.find(
      (s): s is WaitStep => s.kind === 'wait' && s.id === waitingStepId,
    )
    if (waitingStep === undefined) {
      throw startPipelineError(400, `waiting step ${waitingStepId} not found in pipeline`)
    }
    if (waitingStep.outputSchema !== undefined) {
      try {
        await validate(waitingStep.outputSchema, resumeValue, 'output')
      } catch (err) {
        throw startPipelineError(400, (err as Error).message)
      }
    }
    const enforcement = this.ctx.enforcement
    const runner = new Runner({
      approvalGate: enforcement.approvalGate,
      secretResolver: enforcement.secretResolver,
      auditWriter: enforcement.auditWriter,
      store: this.ctx.runStore,
      events: this.ctx.events,
      workspaceManager: this.ctx.workspaceManager,
      ...(this.ctx.backends !== undefined && { backends: this.ctx.backends }),
    })
    this.ctx.attachMetricsBus(runner.events)
    this.ctx.attachOtelBus(runner.events)
    const controller = new AbortController()
    this.registerRun(runId, controller, runner)

    const resumeAccepted = new Promise<void>((resolve, reject) => {
      const unsubscribe = this.ctx.events.forRun(runId, (event) => {
        if (event.type === 'run.resumed') {
          unsubscribe()
          resolve()
        } else if (event.type === 'run.failed') {
          unsubscribe()
          reject(new Error(event.error.message))
        } else if (event.type === 'run.cancelled') {
          unsubscribe()
          reject(new Error(`run ${runId} was cancelled`))
        }
      })
    })

    let handle: ReturnType<Runner['start']>
    try {
      handle = runner.start(pipeline as Parameters<Runner['start']>[0], stored.input as never, {
        runId,
        signal: controller.signal,
        skillSource: createSkillSource({
          registry: this.ctx.registries.skills,
          workflowPath: stored.workflowPath,
        }),
        pipelineRegistry: makeGatewayPipelineRegistry(this.ctx),
        ...this.defaultPermissionRunOptions(pipeline.id),
        ...this.defaultBackendRunOptions(pipeline.id),
        ...this.egressRunOptions(),
        ...this.agentmemoryRunOptions(),
        resumeFromWaiting: { run: stored, resumeValue },
        workflowPath: stored.workflowPath,
        ...(stored.triggerId !== undefined && { triggerId: stored.triggerId }),
      })
    } catch (err) {
      this.unregisterRun(runId)
      throw err
    }

    void handle
      .wait()
      .catch((err) => {
        console.error(
          `gateway: rehydrated run ${runId} wait rejected:`,
          (err as Error)?.message ?? err,
        )
      })
      .finally(() => this.unregisterRun(runId))

    await resumeAccepted
  }

  /**
   * Cancel a running run by aborting its registered AbortController.
   * Returns false if the runId is not in flight (already completed,
   * never started, or unknown to the gateway).
   */
  cancel(runId: string, reason?: string): boolean {
    const controller = this.#inFlightRuns.get(runId)
    if (controller === undefined) return false
    controller.abort(reason)
    this.#inFlightRuns.delete(runId)
    return true
  }

  /**
   * The egress-proxy wiring to pass into every `Runner.start()` the gateway
   * drives. Without it the runner's `hasEgressProxy` hint is false (so the
   * network dimension is treated as unenforceable for subprocess backends like
   * Pi RPC) AND subprocess steps spawn with no `HTTP_PROXY`, bypassing the
   * proxy entirely. The trigger dispatcher already supplies these; every
   * HTTP run path (`skelm run`, `/pipelines/:id/run`, `/v1/*`) must too.
   */
  egressRunOptions(): {
    registerEgressToken: (runId: string, stepId: string, policy: NetworkPolicy) => string
    unregisterEgressToken: (runId: string, stepId: string) => void
    getProxyEnv: (egressToken?: string) => Record<string, string> | undefined
  } {
    return {
      registerEgressToken: (runId, stepId, policy) =>
        this.ctx.registerEgressToken(runId, stepId, policy),
      unregisterEgressToken: (runId, stepId) => this.ctx.unregisterEgressToken(runId, stepId),
      getProxyEnv: (egressToken) => this.ctx.getProxyEnvVars(egressToken),
    }
  }

  /**
   * Run-options block exposing the agentmemory handle factory. Spread into
   * `runner.start(...)` alongside `egressRunOptions()` so backends receive
   * `BackendContext.agentmemory` when the integration is enabled AND the
   * step's resolved policy permits at least one agentmemory operation.
   * Returns an empty object when agentmemory is disabled.
   */
  agentmemoryRunOptions(): {
    agentmemoryHandleFactory?: import('@skelm/core').AgentmemoryHandleFactory
  } {
    const client = this.ctx.getAgentmemoryClient()
    if (client === null) return {}
    const defaultProject = this.ctx.projectRoot
    const auditWriter = this.ctx.enforcement.auditWriter
    return {
      agentmemoryHandleFactory: (ctx) => {
        const anyAllowed = AGENTMEMORY_OPS.some((op) => ctx.canUseAgentmemory(op).allow)
        if (!anyAllowed) return undefined
        const eventsBus = ctx.events
        return createAgentmemoryHandle({
          client,
          canUseAgentmemory: ctx.canUseAgentmemory,
          defaultProject,
          runId: ctx.runId,
          stepId: ctx.stepId,
          ...(eventsBus !== undefined ? { events: (event) => eventsBus.publish(event) } : {}),
          ...(auditWriter !== undefined
            ? { audit: (event) => writeAgentmemoryAudit(auditWriter, event, ctx.runId) }
            : {}),
        })
      },
    }
  }

  /**
   * Project-default permissions to apply to every gateway-driven run. Spread
   * into `runner.start(...)` so a workflow's resolved policy intersects with the
   * operator's `config.defaults.permissions` ceiling (and named profiles).
   *
   * Only the operator's explicitly-declared defaults are applied — the merge in
   * the CLI loader never propagates the framework deny-all baseline, and the
   * gateway's no-config fallback strips it too, so an unset default stays
   * `undefined` (no narrowing) rather than denying every step.
   */
  defaultPermissionRunOptions(workflowId?: string): WorkflowProjectPermissions {
    if (workflowId !== undefined) {
      const project = this.#workflowProjectPermissions.get(workflowId)
      if (project !== undefined) {
        return {
          ...(project.defaultPermissions !== undefined && {
            defaultPermissions: project.defaultPermissions,
          }),
          ...(project.permissionProfiles !== undefined && {
            permissionProfiles: project.permissionProfiles,
          }),
          ...(project.executableProfiles !== undefined && {
            executableProfiles: project.executableProfiles,
          }),
        }
      }
    }
    const defaults = this.ctx.getConfig().defaults
    return {
      ...(defaults?.permissions !== undefined && { defaultPermissions: defaults.permissions }),
      ...(defaults?.permissionProfiles !== undefined && {
        permissionProfiles: defaults.permissionProfiles,
      }),
      ...(defaults?.executableProfiles !== undefined && {
        executableProfiles: defaults.executableProfiles,
      }),
    }
  }

  /**
   * Register a project's `defaults.permissions` + `defaults.permissionProfiles`
   * + `defaults.executableProfiles` for a specific workflow id, so subsequent
   * runs of that workflow use the project's ceiling instead of the
   * operator-wide one. Called by `ProjectActivationService` once per workflow
   * per activation.
   *
   * Per-workflow keying is intentional: it isolates each project's policy to
   * its own workflows so `skelm run a/` followed by `skelm run b/` doesn't
   * leak a's ceiling onto b's workflows (or vice versa).
   */
  registerWorkflowProjectPermissions(
    workflowId: string,
    permissions: WorkflowProjectPermissions,
  ): void {
    if (
      permissions.defaultPermissions === undefined &&
      permissions.permissionProfiles === undefined &&
      permissions.executableProfiles === undefined
    ) {
      this.#workflowProjectPermissions.delete(workflowId)
      return
    }
    this.#workflowProjectPermissions.set(workflowId, permissions)
  }

  /** Drop a workflow's per-project permission ceiling — paired with deactivate. */
  unregisterWorkflowProjectPermissions(workflowId: string): void {
    this.#workflowProjectPermissions.delete(workflowId)
  }

  /**
   * Per-workflow default backend ids, sourced from the activated project's
   * `config.backends.{agent,infer}`. Spread into `runner.start(...)` so an
   * `agent()` / `infer()` step that omits `backend:` resolves to the
   * project's declared default instead of an arbitrary first-registered
   * instance.
   */
  defaultBackendRunOptions(workflowId?: string): WorkflowProjectBackends {
    if (workflowId !== undefined) {
      const project = this.#workflowProjectBackends.get(workflowId)
      if (project !== undefined) {
        return {
          ...(project.defaultAgentBackend !== undefined && {
            defaultAgentBackend: project.defaultAgentBackend,
          }),
          ...(project.defaultInferBackend !== undefined && {
            defaultInferBackend: project.defaultInferBackend,
          }),
        }
      }
    }
    const cfg = this.ctx.getConfig().backends ?? {}
    const agent = typeof cfg.agent === 'string' ? cfg.agent : undefined
    const infer = typeof cfg.infer === 'string' ? cfg.infer : undefined
    return {
      ...(agent !== undefined && { defaultAgentBackend: agent }),
      ...(infer !== undefined && { defaultInferBackend: infer }),
    }
  }

  /**
   * Register a project's default backend ids for a specific workflow id, so
   * subsequent runs of that workflow resolve `agent()`/`infer()` steps with
   * no explicit `backend:` to the project's choice. Called by
   * `ProjectActivationService` once per workflow per activation.
   */
  registerWorkflowProjectBackends(workflowId: string, backends: WorkflowProjectBackends): void {
    if (backends.defaultAgentBackend === undefined && backends.defaultInferBackend === undefined) {
      this.#workflowProjectBackends.delete(workflowId)
      return
    }
    this.#workflowProjectBackends.set(workflowId, backends)
  }

  /** Drop a workflow's per-project backend defaults — paired with deactivate. */
  unregisterWorkflowProjectBackends(workflowId: string): void {
    this.#workflowProjectBackends.delete(workflowId)
  }

  #startRunnerAsync(pipeline: Pipeline, input: unknown, workflowPath: string): { runId: string } {
    const enforcement = this.ctx.enforcement
    const runner = new Runner({
      approvalGate: enforcement.approvalGate,
      secretResolver: enforcement.secretResolver,
      auditWriter: enforcement.auditWriter,
      store: this.ctx.runStore,
      events: this.ctx.events,
      workspaceManager: this.ctx.workspaceManager,
      ...(this.ctx.backends !== undefined && { backends: this.ctx.backends }),
    })
    this.ctx.attachMetricsBus(runner.events)
    this.ctx.attachOtelBus(runner.events)
    const controller = new AbortController()
    const runId = crypto.randomUUID()
    this.registerRun(runId, controller, runner)
    let handle: ReturnType<Runner['start']>
    try {
      handle = runner.start(pipeline as Parameters<Runner['start']>[0], (input ?? {}) as never, {
        runId,
        signal: controller.signal,
        workflowPath,
        skillSource: createSkillSource({
          registry: this.ctx.registries.skills,
          workflowPath,
        }),
        pipelineRegistry: makeGatewayPipelineRegistry(this.ctx),
        ...this.defaultPermissionRunOptions(pipeline.id),
        ...this.defaultBackendRunOptions(pipeline.id),
        ...this.egressRunOptions(),
        ...this.agentmemoryRunOptions(),
      })
    } catch (err) {
      this.unregisterRun(runId)
      throw err
    }
    void handle
      .wait()
      .catch((err) => {
        console.error(`gateway: run ${runId} wait rejected:`, (err as Error)?.message ?? err)
      })
      .finally(() => this.unregisterRun(runId))
    return { runId }
  }
}

function writeAgentmemoryAudit(
  writer: GatewayEnforcement['auditWriter'],
  event: AgentmemoryAuditEvent,
  runId: string | undefined,
): void {
  const { type, at: _at, ...details } = event
  void writer
    .write({
      timestamp: new Date(event.at).toISOString(),
      ...(runId !== undefined ? { runId } : {}),
      actor: 'agentmemory',
      action: type,
      details,
    })
    .catch(() => {
      /* audit writer failures are non-fatal for the agent loop */
    })
}

function startPipelineError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number }
  err.statusCode = statusCode
  return err
}
