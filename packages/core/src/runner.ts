import {
  type AgentRequest,
  BackendCapabilityError,
  BackendNotFoundError,
  type BackendRegistry,
  type SkelmBackend,
} from './backend.js'
import {
  type ApprovalGate,
  type AuditWriter,
  AutoApproveGate,
  EnvSecretResolver,
  MissingSecretError,
  NoopAuditWriter,
  type SecretResolver,
} from './enforcement/index.js'
import {
  ApprovalDeniedError,
  InvokePipelineNotFoundError,
  PermissionDeniedError,
  RunCancelledError,
  RunStateError,
  WaitTimeoutError,
  serializeError,
} from './errors.js'
export { ApprovalDeniedError } from './errors.js'
import { EventBus } from './events.js'
import { runStepWithRetry } from './execution/handlers.js'
import type { ExecutionRuntime } from './execution/runtime.js'
import { extractJsonFromText, tryParseJson } from './json-utils.js'
import { createMcpHost } from './mcp/host.js'
import type { AgentPermissions, NetworkPolicy, PermissionDimension } from './permissions.js'
import { TrustEnforcer, createPolicyFetch, resolvePermissions } from './permissions.js'
import {
  type ArtifactStore,
  type ArtifactStoreHandle,
  MemoryRunStore,
  type RunStore,
  type StateStore,
} from './run-store.js'
import {
  adoptLastStepOutput,
  applyWorkspacePermissions,
  freezeContext,
  generateRunId,
  idempotentStateKey,
  isRetryableError,
  resolveIdempotentKey,
  restoreSerializedError,
  sleep,
  uniqueStrings,
} from './runner-utils.js'
import { SchemaValidationError, validate } from './schema.js'
import { createStateHandle } from './state.js'
import { createThreadHost } from './threads.js'
import type {
  Context,
  Pipeline,
  Run,
  RunMetadata,
  RunStatus,
  Step,
  StepId,
  StepKind,
  StepResult,
  WorkspaceHandle,
} from './types.js'
import { WorkspaceManager } from './workspace.js'

export interface RunOptions {
  /** Optional run id; generated if omitted. */
  runId?: string
  /** Optional abort signal to cancel the run from outside. */
  signal?: AbortSignal
  /** Optional event bus to publish run events to; one is created if omitted. */
  events?: EventBus
  /** Optional backend registry; required if any step references a backend. */
  backends?: BackendRegistry
  /** Optional durable run store that persists events and final run records. */
  store?: RunStore
  /** Optional state store used by ctx.state; defaults to store, then in-memory. */
  stateStore?: StateStore
  /** Optional default permissions applied to every agent() step. */
  defaultPermissions?: AgentPermissions
  /** Optional named permission profiles referenced by permissions.profile. */
  permissionProfiles?: Readonly<Record<string, AgentPermissions>>
  /** Optional workspace manager used by agent() steps with workspaces. */
  workspaceManager?: WorkspaceManager
  /** Optional hook used by wait() steps to suspend until external input arrives. */
  waitForInput?: (request: WaitRequest) => Promise<unknown>
  /**
   * Optional approval gate consulted at the start of every agent step whose
   * resolved policy declares `permissions.approval`. The runtime suspends
   * the step until the gate resolves and fails the step with
   * ApprovalDeniedError if the decision is `approved: false`.
   *
   * Defaults to AutoApproveGate when omitted (test-friendly). Production
   * gateways inject SuspendApprovalGate here.
   */
  approvalGate?: ApprovalGate
  /**
   * Optional hook invoked just before each step's body runs (after the
   * step.start event is published, before any retry/backend dispatch).
   * The returned promise gates step execution: callers can pause runs at
   * specific step ids for inspection by holding the promise. Throwing or
   * resolving with rejection treats the step as failed.
   *
   * Used by the gateway's debug surface: a registered breakpoint resolves
   * via this hook only after the operator releases the run.
   */
  beforeStep?: (info: { runId: string; stepId: StepId; kind: StepKind }) => Promise<void>
  /**
   * Optional absolute path to the workflow file. Stored on the Run record
   * so consumers can correlate runs back to their source file without
   * having to re-scan the registry.
   */
  workflowPath?: string
  /**
   * Optional id of the trigger (cron / webhook / queue / interval / manual)
   * that produced this run. Stored on the Run record so consumers can
   * `listRuns({ triggerId })` to find every run a given schedule fired.
   * Set by the gateway dispatcher; absent for runs started directly via
   * `runPipeline()` or HTTP `POST /pipelines/<id>/run`.
   */
  triggerId?: string
  /**
   * Optional skill source consulted when an agent step's resolved policy
   * declares allowedSkills. The runner wraps this with canLoadSkill checks
   * so each lookup is gated by the step's permission policy. If omitted,
   * loadSkill on BackendContext is not set and native-skill backends receive
   * no skill provider.
   */
  skillSource?: (skillId: string) => Promise<import('./skills.js').Skill | null>
  /**
   * Optional secret resolver consulted when an agent step declares
   * `secrets: [...]`. The runner gates each name through `canAccessSecret`
   * (default-deny via `permissions.allowedSecrets`) before resolving. When
   * omitted, declared secrets cannot resolve and the step fails.
   */
  secretResolver?: SecretResolver
  /**
   * Optional audit writer for the durable permission/tool record. When
   * omitted the runner subscribes a no-op writer, which is why bare
   * runPipeline() invocations and the one-shot CLI (`skelm run`) produced
   * empty audit logs prior to v0.3.8 — see F018.
   */
  auditWriter?: AuditWriter
  /**
   * Optional callback to register an egress token for network policy enforcement.
   * Called before each agent step with the runId, stepId, and resolved network policy.
   * Returns a token string that will be injected into the BackendContext.
   * When omitted, no egress token is provided to backends.
   */
  registerEgressToken?: (runId: string, stepId: string, policy: NetworkPolicy) => string
  /**
   * Optional callback to unregister an egress token when an agent step completes.
   * Called after each agent step with the runId and stepId.
   */
  unregisterEgressToken?: (runId: string, stepId: string) => void
  /**
   * Optional callback returning per-step environment variables (HTTP_PROXY,
   * HTTPS_PROXY, SKELM_EGRESS_TOKEN) for the gateway egress proxy. The token
   * (when provided) is encoded as the URL credential of HTTP_PROXY. The
   * runner threads the result into BackendContext.proxyEnv so subprocess
   * backends can inject it into the spawned agent's env.
   */
  getProxyEnv?: (egressToken?: string) => Record<string, string> | undefined
  /**
   * Optional registry for resolving pipelines by ID for `invoke()` steps.
   * When omitted, invoke() steps throw InvokePipelineNotFoundError.
   */
  pipelineRegistry?: (pipelineId: string) => Pipeline | undefined | Promise<Pipeline | undefined>
}

export class BackendChainExhaustedError extends Error {
  override readonly name = 'BackendChainExhaustedError'
  constructor(
    readonly stepId: string,
    readonly attempts: ReadonlyArray<{ backendId: string; cause: unknown }>,
  ) {
    const summary = attempts.map((a) => `${a.backendId}: ${fallbackReason(a.cause)}`).join('; ')
    super(`step "${stepId}" exhausted backend chain — ${summary}`)
  }
}

function fallbackReason(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

export interface WaitRequest {
  readonly runId: string
  readonly pipelineId: string
  readonly stepId: StepId
  readonly signal: AbortSignal
  readonly message?: string
  readonly timeoutMs?: number
  readonly outputSchema?: import('./schema.js').SkelmSchema<unknown>
}

const defaultStateStore = new MemoryRunStore()

export interface RunHandle<TInput = unknown, TOutput = unknown> {
  readonly runId: string
  wait(): Promise<Run<TInput, TOutput>>
}

export interface RunnerEnforcement {
  /** Audit writer; defaults to NoopAuditWriter (in-process tests / bare runPipeline). */
  auditWriter?: AuditWriter
  /** Secret resolver; defaults to EnvSecretResolver. */
  secretResolver?: SecretResolver
  /** Approval gate; defaults to AutoApproveGate. */
  approvalGate?: ApprovalGate
}

export class Runner {
  readonly events: EventBus
  /** Trust-boundary instances. The gateway supplies canonical writers in production; */
  /** in-process callers get safe defaults so unit tests stay self-contained. */
  readonly enforcement: Required<RunnerEnforcement>
  private readonly pendingWaits = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }
  >()

  constructor(
    private readonly options: Pick<
      RunOptions,
      | 'backends'
      | 'store'
      | 'stateStore'
      | 'defaultPermissions'
      | 'permissionProfiles'
      | 'workspaceManager'
    > & { events?: EventBus } & RunnerEnforcement = {},
  ) {
    this.events = options.events ?? new EventBus()
    this.enforcement = {
      auditWriter: options.auditWriter ?? new NoopAuditWriter(),
      secretResolver: options.secretResolver ?? new EnvSecretResolver(),
      approvalGate: options.approvalGate ?? new AutoApproveGate(),
    }
    // The bus emits denial/secret/tool events for observability; the audit
    // writer is the durable record, so translate the relevant events here.
    this.events.subscribe((event) => {
      if (event.type === 'permission.denied') {
        void this.enforcement.auditWriter
          .write({
            runId: event.runId,
            actor: 'runtime',
            action: 'permission.denied',
            details: {
              stepId: event.stepId,
              dimension: event.dimension,
              detail: event.detail,
              at: event.at,
            },
          })
          .catch(() => {
            // audit writer failures must not poison the run.
          })
      }
      if (event.type === 'secret.not_found') {
        void this.enforcement.auditWriter
          .write({
            runId: event.runId,
            actor: 'runtime',
            action: 'secret.not_found',
            details: { stepId: event.stepId, name: event.name, at: event.at },
          })
          .catch(() => {
            // audit writer failures must not poison the run.
          })
      }
      // Record successful tool calls so the audit log captures legitimate
      // privileged operations, not just denials.
      if (event.type === 'tool.call') {
        void this.enforcement.auditWriter
          .write({
            runId: event.runId,
            actor: 'runtime',
            action: 'mcp.tool.invoked',
            details: { stepId: event.stepId, tool: event.tool, at: event.at },
          })
          .catch(() => {})
      }
      if (event.type === 'tool.result') {
        void this.enforcement.auditWriter
          .write({
            runId: event.runId,
            actor: 'runtime',
            action: 'mcp.tool.completed',
            details: {
              stepId: event.stepId,
              tool: event.tool,
              durationMs: event.durationMs,
              at: event.at,
            },
          })
          .catch(() => {})
      }
    })
  }

  start<TInput, TOutput>(
    pipeline: Pipeline<TInput, TOutput>,
    input: TInput,
    options: Omit<RunOptions, 'events' | 'backends' | 'waitForInput'> = {},
  ): RunHandle<TInput, TOutput> {
    const runId = options.runId ?? crypto.randomUUID()
    const promise = runPipeline(pipeline, input, {
      ...options,
      runId,
      events: this.events,
      ...(this.options.backends !== undefined && { backends: this.options.backends }),
      ...(this.options.store !== undefined && { store: this.options.store }),
      ...(this.options.stateStore !== undefined && { stateStore: this.options.stateStore }),
      ...(this.options.defaultPermissions !== undefined && {
        defaultPermissions: this.options.defaultPermissions,
      }),
      ...(this.options.permissionProfiles !== undefined && {
        permissionProfiles: this.options.permissionProfiles,
      }),
      ...(this.options.workspaceManager !== undefined && {
        workspaceManager: this.options.workspaceManager,
      }),
      approvalGate: this.enforcement.approvalGate,
      secretResolver: this.enforcement.secretResolver,
      waitForInput: (request) => this.awaitResume(request),
    })
    return {
      runId,
      wait: () => promise,
    }
  }

  async resume(runId: string, value: unknown): Promise<void> {
    const pending = this.pendingWaits.get(runId)
    if (!pending) {
      throw new RunStateError(runId, `run ${runId} is not waiting`)
    }
    this.pendingWaits.delete(runId)
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer)
    }
    pending.resolve(value)
  }

  private awaitResume(request: WaitRequest): Promise<unknown> {
    if (this.pendingWaits.has(request.runId)) {
      throw new RunStateError(request.runId, `run ${request.runId} is already waiting`)
    }
    return new Promise<unknown>((resolve, reject) => {
      const pending: {
        resolve: (value: unknown) => void
        reject: (error: Error) => void
        timer?: NodeJS.Timeout
      } = {
        resolve,
        reject,
      }
      this.pendingWaits.set(request.runId, pending)

      const onAbort = () => {
        cleanup()
        reject(new RunCancelledError())
      }
      request.signal.addEventListener('abort', onAbort, { once: true })

      const cleanup = () => {
        request.signal.removeEventListener('abort', onAbort)
        if (pending.timer !== undefined) {
          clearTimeout(pending.timer)
        }
        this.pendingWaits.delete(request.runId)
      }

      pending.resolve = (value) => {
        cleanup()
        resolve(value)
      }
      pending.reject = (error) => {
        cleanup()
        reject(error)
      }

      if (request.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          pending.reject(
            new WaitTimeoutError(`wait(${request.stepId}) timed out after ${request.timeoutMs}ms`),
          )
        }, request.timeoutMs)
        pending.timer.unref?.()
      }
    })
  }
}

/**
 * Execute a pipeline against an input. Returns the final Run record.
 *
 * The runner is sequential: it walks `pipeline.steps` in declaration order,
 * builds a fresh Context for each step (with the prior step's output merged
 * into ctx.steps), invokes the step handler, and records a StepResult.
 *
 * If `pipeline.finalize` is provided, its return value is the run's output.
 * Otherwise the last step's output is adopted as the output.
 */
export async function runPipeline<TInput, TOutput>(
  pipeline: Pipeline<TInput, TOutput>,
  input: TInput,
  options: RunOptions = {},
): Promise<Run<TInput, TOutput>> {
  const startedAt = Date.now()
  const runId = options.runId ?? generateRunId()
  const events = options.events ?? new EventBus()
  const store = options.store
  const stateStore = options.stateStore ?? options.store ?? defaultStateStore
  const threadHost = createThreadHost(stateStore)
  // ArtifactStore is part of the RunStore surface; fall back to the default
  // in-memory store so ctx.artifacts is always available even when the caller
  // didn't wire a durable store.
  const artifactStore: ArtifactStore = options.store ?? defaultStateStore
  const makeArtifactsHandle = (stepId: StepId): ArtifactStoreHandle => ({
    put: async (opts) => {
      const startedAt = Date.now()
      const descriptor = await artifactStore.putArtifact({
        runId,
        stepId,
        name: opts.name,
        mimeType: opts.mimeType,
        data: opts.data,
      })
      events.publish({
        type: 'tool.result',
        runId,
        stepId,
        tool: 'artifacts.put',
        result: {
          artifactId: descriptor.artifactId,
          name: descriptor.name,
          mimeType: descriptor.mimeType,
          size: descriptor.size,
        },
        durationMs: Date.now() - startedAt,
        at: Date.now(),
      })
      return descriptor
    },
    get: (ref) => artifactStore.getArtifact(ref),
    list: (opts) => artifactStore.listArtifacts(runId, opts),
  })
  const storeWrites: Promise<void>[] = []
  const workspaceManager = options.workspaceManager ?? new WorkspaceManager()
  const deferredWorkspaceFinalizers: Array<(status: RunStatus) => Promise<void>> = []
  let currentWorkspace: Context['workspace']
  // Bounded backpressure on store.appendEvent: cap concurrent fs writes and
  // emit a single run.warning when the queue depth crosses the saturation
  // threshold so operators can see a slow store before runs silently stall.
  const APPEND_BACKPRESSURE_CAP = 256
  let appendInflight = 0
  let appendSaturated = false
  const unsubscribeStore =
    store === undefined
      ? undefined
      : events.subscribe((event) => {
          appendInflight += 1
          if (appendInflight >= APPEND_BACKPRESSURE_CAP && !appendSaturated) {
            appendSaturated = true
            events.publish({
              type: 'run.warning',
              runId,
              code: 'store.saturated',
              message: `appendEvent queue depth reached ${appendInflight} (cap ${APPEND_BACKPRESSURE_CAP})`,
              at: Date.now(),
            })
          }
          storeWrites.push(
            store.appendEvent(event).finally(() => {
              appendInflight -= 1
              if (appendSaturated && appendInflight === 0) {
                appendSaturated = false
                events.publish({
                  type: 'run.warning',
                  runId,
                  code: 'store.recovered',
                  message: 'appendEvent queue drained',
                  at: Date.now(),
                })
              }
            }),
          )
        })
  // Bridge permission denials and MCP tool dispatch into the audit log.
  // Mirrors the same subscriptions installed by the Runner constructor, so
  // callers driving runPipeline directly (e.g. the one-shot `skelm run`
  // CLI) get the same audit coverage as gateway-fired runs. Writes are
  // tracked alongside storeWrites so the run waits for fsync before
  // returning — otherwise a fast-failing CLI exit could drop the entry.
  const auditWriter = options.auditWriter
  const auditWrites: Promise<void>[] = []
  if (auditWriter !== undefined) {
    events.subscribe((event) => {
      const queue = (entry: { action: string; details: Record<string, unknown> }) => {
        auditWrites.push(
          auditWriter
            .write({
              ...(event.runId !== undefined && { runId: event.runId }),
              actor: 'runtime',
              action: entry.action,
              details: entry.details,
            })
            .catch(() => {}),
        )
      }
      if (event.type === 'permission.denied') {
        queue({
          action: 'permission.denied',
          details: {
            stepId: event.stepId,
            dimension: event.dimension,
            detail: event.detail,
            at: event.at,
          },
        })
      } else if (event.type === 'secret.not_found') {
        queue({
          action: 'secret.not_found',
          details: { stepId: event.stepId, name: event.name, at: event.at },
        })
      } else if (event.type === 'tool.call') {
        queue({
          action: 'mcp.tool.invoked',
          details: { stepId: event.stepId, tool: event.tool, at: event.at },
        })
      } else if (event.type === 'tool.result') {
        queue({
          action: 'mcp.tool.completed',
          details: {
            stepId: event.stepId,
            tool: event.tool,
            durationMs: event.durationMs,
            at: event.at,
          },
        })
      }
    })
  }
  const controller = new AbortController()
  // Capture the abort handler so finalizeStoredRun can detach it before
  // returning. Without removeEventListener, a long-lived caller signal
  // (test harness, embedded host) accumulates one listener per run.
  let unsubscribeAbort: (() => void) | undefined
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason)
    } else {
      const callerSignal = options.signal
      const abortHandler = () => controller.abort(callerSignal.reason)
      callerSignal.addEventListener('abort', abortHandler, { once: true })
      unsubscribeAbort = () => callerSignal.removeEventListener('abort', abortHandler)
    }
  }

  events.publish({
    type: 'run.created',
    runId,
    pipelineId: pipeline.id,
    input,
    at: startedAt,
  })
  events.publish({ type: 'run.started', runId, at: startedAt })

  // Persist a `running` Run record up-front so a gateway crash leaves a
  // recoverable seed in the store. Without this, events stream out but no
  // Run row exists until finalizeStoredRun() at the end — a mid-run crash
  // would orphan the events and break listRuns({status: 'running'}).
  if (store !== undefined) {
    storeWrites.push(
      store.putRun(
        Object.freeze({
          runId,
          pipelineId: pipeline.id,
          ...(options.workflowPath !== undefined && { workflowPath: options.workflowPath }),
          ...(options.triggerId !== undefined && { triggerId: options.triggerId }),
          status: 'running',
          input,
          steps: Object.freeze([]),
          output: undefined,
          error: undefined,
          startedAt,
          completedAt: undefined,
        }) as Run,
      ),
    )
  }

  const runMeta: RunMetadata = {
    runId,
    pipelineId: pipeline.id,
    startedAt,
  }

  const stepResults: StepResult[] = []
  const stepOutputs: Record<StepId, unknown> = {}
  let runStatus: Run['status'] = 'running'
  let runError: Run['error'] = undefined
  let finalOutput: TOutput | undefined
  let resolvedInput = input

  if (pipeline.inputSchema !== undefined) {
    try {
      resolvedInput = await validate(pipeline.inputSchema, input, 'input', {
        pipelineId: pipeline.id,
      })
    } catch (err) {
      runStatus = 'failed'
      runError = serializeError(err)
      const completedAt = Date.now()
      events.publish({ type: 'run.failed', runId, error: runError, at: completedAt })
      return await finalizeStoredRun(
        Object.freeze({
          runId,
          pipelineId: pipeline.id,
          ...(options.workflowPath !== undefined && { workflowPath: options.workflowPath }),
          ...(options.triggerId !== undefined && { triggerId: options.triggerId }),
          status: runStatus,
          input,
          steps: Object.freeze(stepResults),
          output: undefined,
          error: runError,
          startedAt,
          completedAt,
        }),
        store,
        storeWrites,
        unsubscribeStore,
        auditWrites,
        unsubscribeAbort,
      )
    }
  }

  for (const step of pipeline.steps) {
    if (controller.signal.aborted) {
      runStatus = 'cancelled'
      runError = serializeError(new RunCancelledError())
      break
    }

    if (step.when !== undefined) {
      const predicateCtx: Context<TInput> = freezeContext({
        input: resolvedInput,
        steps: { ...stepOutputs },
        run: runMeta,
        signal: controller.signal,
        state: createStateHandle(stateStore, { pipelineId: pipeline.id, stepId: step.id }),
        threads: threadHost,
        workspace: currentWorkspace as WorkspaceHandle | undefined,
        get<T = unknown>(stepId: StepId): T | undefined {
          return stepOutputs[stepId] as T | undefined
        },
      } as Context<TInput>)
      let shouldRun: boolean
      try {
        shouldRun = await step.when(predicateCtx)
      } catch (err) {
        const completedAt = Date.now()
        const serialized = serializeError(err)
        stepResults.push({
          id: step.id,
          kind: step.kind,
          status: 'failed',
          output: undefined,
          startedAt: completedAt,
          completedAt,
          error: serialized,
        })
        events.publish({
          type: 'step.error',
          runId,
          stepId: step.id,
          kind: step.kind,
          error: serialized,
          at: completedAt,
        })
        runStatus = err instanceof RunCancelledError ? 'cancelled' : 'failed'
        runError = serialized
        break
      }
      if (!shouldRun) {
        const at = Date.now()
        stepResults.push({
          id: step.id,
          kind: step.kind,
          status: 'skipped',
          output: undefined,
          startedAt: at,
          completedAt: at,
        })
        events.publish({ type: 'step.skipped', runId, stepId: step.id, kind: step.kind, at })
        continue
      }
    }

    const stepStart = Date.now()
    events.publish({ type: 'step.start', runId, stepId: step.id, kind: step.kind, at: stepStart })
    if (options.beforeStep !== undefined) {
      await options.beforeStep({ runId, stepId: step.id, kind: step.kind })
    }
    try {
      const ctx: Context<TInput> = freezeContext({
        input: resolvedInput,
        steps: { ...stepOutputs },
        run: runMeta,
        signal: controller.signal,
        state: createStateHandle(stateStore, {
          pipelineId: pipeline.id,
          stepId: step.id,
          ...(step.state !== undefined && { config: step.state }),
        }),
        threads: threadHost,
        workspace: currentWorkspace as WorkspaceHandle | undefined,
        artifacts: makeArtifactsHandle(step.id),
        get<T = unknown>(stepId: StepId): T | undefined {
          return stepOutputs[stepId] as T | undefined
        },
      } as Context<TInput>)
      const output = await runStepWithRetry(
        step,
        ctx,
        options.backends,
        options.waitForInput,
        events,
        {
          workspaceManager,
          stateStore,
          ...(options.defaultPermissions !== undefined && {
            defaultPermissions: options.defaultPermissions,
          }),
          ...(options.permissionProfiles !== undefined && {
            permissionProfiles: options.permissionProfiles,
          }),
          ...(options.approvalGate !== undefined && { approvalGate: options.approvalGate }),
          ...(options.skillSource !== undefined && { skillSource: options.skillSource }),
          ...(options.secretResolver !== undefined && { secretResolver: options.secretResolver }),
          ...(options.registerEgressToken !== undefined && {
            registerEgressToken: options.registerEgressToken,
          }),
          ...(options.unregisterEgressToken !== undefined && {
            unregisterEgressToken: options.unregisterEgressToken,
          }),
          ...(options.getProxyEnv !== undefined && { getProxyEnv: options.getProxyEnv }),
          ...(options.pipelineRegistry !== undefined && {
            pipelineRegistry: options.pipelineRegistry,
          }),
          currentWorkspace,
          ...(pipeline.baseDir !== undefined && { pipelineBaseDir: pipeline.baseDir }),
          ...(store !== undefined && { store }),
          setCurrentWorkspace: (workspace) => {
            currentWorkspace = workspace
          },
          deferRunWorkspaceFinalizer: (finalizer) => {
            deferredWorkspaceFinalizers.push(finalizer)
          },
        },
      )
      const completedAt = Date.now()
      stepOutputs[step.id] = output
      stepResults.push({
        id: step.id,
        kind: step.kind,
        status: 'completed',
        output,
        startedAt: stepStart,
        completedAt,
      })
      events.publish({
        type: 'step.complete',
        runId,
        stepId: step.id,
        kind: step.kind,
        output,
        durationMs: completedAt - stepStart,
        at: completedAt,
      })
    } catch (err) {
      const completedAt = Date.now()
      const serialized = serializeError(err)
      stepResults.push({
        id: step.id,
        kind: step.kind,
        status: 'failed',
        output: undefined,
        startedAt: stepStart,
        completedAt,
        error: serialized,
      })
      events.publish({
        type: 'step.error',
        runId,
        stepId: step.id,
        kind: step.kind,
        error: serialized,
        at: completedAt,
      })
      runStatus = err instanceof RunCancelledError ? 'cancelled' : 'failed'
      runError = serialized
      break
    }
  }

  if (runStatus === 'running') {
    try {
      const ctx: Context<TInput> = freezeContext({
        input: resolvedInput,
        steps: { ...stepOutputs },
        run: runMeta,
        signal: controller.signal,
        state: createStateHandle(stateStore, { pipelineId: pipeline.id }),
        threads: threadHost,
        workspace: currentWorkspace as WorkspaceHandle | undefined,
        get<T = unknown>(stepId: StepId): T | undefined {
          return stepOutputs[stepId] as T | undefined
        },
      } as Context<TInput>)
      if (pipeline.finalize) {
        finalOutput = await pipeline.finalize(ctx)
      } else {
        finalOutput = adoptLastStepOutput<TOutput>(stepResults)
      }
      if (pipeline.outputSchema !== undefined && finalOutput !== undefined) {
        finalOutput = await validate(pipeline.outputSchema, finalOutput, 'output', {
          pipelineId: pipeline.id,
        })
      }
      runStatus = 'completed'
    } catch (err) {
      runStatus = 'failed'
      runError = serializeError(err)
    }
  }

  const completedAt = Date.now()
  await Promise.all(deferredWorkspaceFinalizers.map((finalizer) => finalizer(runStatus)))
  if (runStatus === 'completed') {
    events.publish({
      type: 'run.completed',
      runId,
      output: finalOutput,
      durationMs: completedAt - startedAt,
      at: completedAt,
    })
  } else if (runStatus === 'failed') {
    events.publish({
      type: 'run.failed',
      runId,
      error: runError ?? serializeError(new Error('unknown run failure')),
      at: completedAt,
    })
  } else if (runStatus === 'cancelled') {
    events.publish({ type: 'run.cancelled', runId, at: completedAt })
  }

  return await finalizeStoredRun(
    Object.freeze({
      runId,
      pipelineId: pipeline.id,
      ...(options.workflowPath !== undefined && { workflowPath: options.workflowPath }),
      ...(options.triggerId !== undefined && { triggerId: options.triggerId }),
      status: runStatus,
      input: resolvedInput,
      steps: Object.freeze(stepResults),
      output: runStatus === 'completed' ? finalOutput : undefined,
      error: runError,
      startedAt,
      completedAt,
    }),
    store,
    storeWrites,
    unsubscribeStore,
    auditWrites,
    unsubscribeAbort,
  )
}

export { SchemaValidationError }

async function finalizeStoredRun<TRun extends Run>(
  run: TRun,
  store: RunStore | undefined,
  storeWrites: Promise<void>[],
  unsubscribeStore: (() => void) | undefined,
  auditWrites: Promise<void>[] = [],
  unsubscribeAbort?: () => void,
): Promise<TRun> {
  try {
    await Promise.all(storeWrites)
    await Promise.all(auditWrites)
    await store?.putRun(run)
    return run
  } finally {
    unsubscribeStore?.()
    unsubscribeAbort?.()
  }
}
