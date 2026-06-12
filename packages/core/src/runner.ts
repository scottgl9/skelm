import { createAssetHost } from './assets.js'
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
  UnknownExecutableProfileError,
  WaitTimeoutError,
  serializeError,
} from './errors.js'
export { ApprovalDeniedError } from './errors.js'
import { EventBus, type EventListener } from './events.js'
import { runStepWithRetry } from './execution/handlers.js'
import type { ExecutionRuntime } from './execution/runtime.js'
import { extractJsonFromText, tryParseJson } from './json-utils.js'
import { createMcpHost } from './mcp/host.js'
import type {
  AgentPermissions,
  ExecutableProfileDefinition,
  NetworkPolicy,
  PermissionDimension,
  ResolvedPolicy,
} from './permissions.js'
import { TrustEnforcer, createPolicyFetch, resolvePermissions } from './permissions.js'
import { type ArtifactStore, MemoryRunStore, type RunStore, type StateStore } from './run-store.js'
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
import { createArtifactsHandle } from './runner/artifacts.js'
import { bindAbortSignal, finalizeStoredRun } from './runner/finalization.js'
import {
  logStoreFailure,
  subscribeAuditEvents,
  subscribeRunStateMirror,
  subscribeStoreEvents,
} from './runner/subscriptions.js'
import { SchemaValidationError, validate } from './schema.js'
import { createStateHandle } from './state.js'
import { createThreadHost } from './threads.js'
import type {
  Context,
  Pipeline,
  Run,
  RunId,
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
  /**
   * Optional listener invoked for every run event as it is published, live.
   * Unlike `events` (which lets the caller own the whole bus), this subscribes a
   * single listener to the run's bus without replacing it — used by the gateway
   * to stream a run's events to a queue driver's `onEvent` hook (e.g. a TUI
   * frontend rendering step.partial deltas as the turn is generated). Without
   * this the option was silently ignored and streaming frontends saw nothing.
   */
  onEvent?: EventListener
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
  /**
   * Optional operator-defined executable profile definitions referenced by
   * `permissions.executableProfiles`. Supplied by the trust boundary (gateway
   * config), never by workflow authors; an unknown reference fails the run
   * before any step starts.
   */
  executableProfiles?: Readonly<Record<string, ExecutableProfileDefinition>>
  /**
   * Optional default backend id for agent() steps whose own `backend` is
   * undefined — supplied by the gateway from the activated project's
   * `config.backends.agent`. Without this, `resolveForAgent` falls back to
   * the first registered backend with `run()` capability, which is
   * non-deterministic across project configs that absorb multiple instances.
   */
  defaultAgentBackend?: string
  /**
   * Optional default backend id for `infer()` steps whose own `backend` is
   * undefined — supplied by the gateway from the activated project's
   * `config.backends.infer`. Same rationale as `defaultAgentBackend`.
   */
  defaultInferBackend?: string
  /**
   * Operator grant for the unrestricted bypass. Supplied only by the gateway
   * (the trust boundary) for workflows / persistent workflows it has allowlisted.
   * A step's `requestUnrestricted` is inert unless this is true. See
   * `docs/concepts/permissions.md`.
   */
  unrestrictedGrant?: boolean
  /** Optional workspace manager used by agent() steps with workspaces. */
  workspaceManager?: WorkspaceManager
  /** Optional hook used by wait() steps to suspend until external input arrives. */
  waitForInput?: (request: WaitRequest) => Promise<unknown>
  /**
   * Resume a run that was durably parked at wait() after its original in-memory
   * Runner was lost. The runner seeds completed/skipped steps from the stored
   * Run and starts at the waiting step, so prior step side effects are not
   * replayed.
   */
  resumeFromWaiting?: {
    run: Run
    resumeValue: unknown
  }
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
   * Optional parent run id, stored on the Run record when this run was
   * dispatched as a child of another run (e.g. a detached task). Lets
   * lineage queries reconstruct ancestry without a side table.
   */
  parentRunId?: RunId
  /** Optional id of the parent step that spawned this run, stored on the Run record. */
  parentStepId?: StepId
  /**
   * Optional detached-task id, stored on the Run record so a Run can be
   * correlated back to its TaskRecord. Set by the gateway tasks dispatch.
   */
  taskId?: string
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
   * Optional factory that produces a per-step `AgentmemoryHandle`. The
   * gateway wires this from `config.agentmemory` when enabled. The runner
   * invokes it after permissions resolution, with a `canUseAgentmemory`
   * predicate bound to the step's resolved policy, and injects the result
   * into `BackendContext.agentmemory`. Omitting it disables agentmemory.
   */
  agentmemoryHandleFactory?: import('./backend.js').AgentmemoryHandleFactory
  /**
   * Optional registry for resolving pipelines by ID for `invoke()` steps.
   * When omitted, invoke() steps throw InvokePipelineNotFoundError.
   */
  pipelineRegistry?: (pipelineId: string) => Pipeline | undefined | Promise<Pipeline | undefined>
  /**
   * Upper bound applied to every agent step's resolved policy. Set by the
   * delegation path when this run is a delegated child — it is the delegating
   * agent's resolved policy. Resolved policies are intersected with it so a
   * delegated child can never exceed the parent. Omitted for top-level runs.
   */
  delegationCeiling?: ResolvedPolicy
  /**
   * Pipeline ids already on the delegation chain (oldest first). The runner
   * seeds this with the running pipeline id when absent; the delegation path
   * appends each target and rejects a target already present (cycle).
   */
  delegationStack?: readonly string[]
  /** Number of delegations taken to reach this run; 0 (default) at top level. */
  delegationDepth?: number
  /** Cap on delegation depth; defaults to DEFAULT_MAX_DELEGATION_DEPTH. */
  maxDelegationDepth?: number
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
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer?: NodeJS.Timeout
      outputSchema?: import('./schema.js').SkelmSchema<unknown>
    }
  >()

  constructor(
    private readonly options: Pick<
      RunOptions,
      | 'backends'
      | 'store'
      | 'stateStore'
      | 'defaultPermissions'
      | 'permissionProfiles'
      | 'executableProfiles'
      | 'unrestrictedGrant'
      | 'workspaceManager'
    > & { events?: EventBus } & RunnerEnforcement = {},
  ) {
    this.events = options.events ?? new EventBus()
    this.enforcement = {
      auditWriter: options.auditWriter ?? new NoopAuditWriter(),
      secretResolver: options.secretResolver ?? new EnvSecretResolver(),
      approvalGate: options.approvalGate ?? new AutoApproveGate(),
    }
  }

  start<TInput, TOutput>(
    pipeline: Pipeline<TInput, TOutput>,
    input: TInput,
    options: Omit<RunOptions, 'events' | 'backends' | 'waitForInput'> = {},
  ): RunHandle<TInput, TOutput> {
    const runId = options.runId ?? crypto.randomUUID()
    const resumeFromWaiting = options.resumeFromWaiting
    // Synchronous preflight so gateway start paths reject an unknown
    // executable profile reference at load time instead of surfacing it as an
    // async rejection on a runId the caller already received.
    assertExecutableProfileRefs(
      pipeline.steps,
      this.options.defaultPermissions ?? options.defaultPermissions,
      this.options.permissionProfiles ?? options.permissionProfiles,
      this.options.executableProfiles ?? options.executableProfiles,
    )
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
      ...(this.options.executableProfiles !== undefined && {
        executableProfiles: this.options.executableProfiles,
      }),
      ...(this.options.unrestrictedGrant !== undefined && {
        unrestrictedGrant: this.options.unrestrictedGrant,
      }),
      ...(this.options.workspaceManager !== undefined && {
        workspaceManager: this.options.workspaceManager,
      }),
      approvalGate: this.enforcement.approvalGate,
      secretResolver: this.enforcement.secretResolver,
      auditWriter: this.enforcement.auditWriter,
      waitForInput: (request) => {
        if (
          resumeFromWaiting !== undefined &&
          resumeFromWaiting.run.runId === request.runId &&
          resumeFromWaiting.run.waiting?.stepId === request.stepId
        ) {
          return Promise.resolve(resumeFromWaiting.resumeValue)
        }
        return this.awaitResume(request)
      },
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
    // Validate the resume value against the wait step's declared output schema
    // BEFORE resolving. A schema-invalid resume is rejected synchronously (the
    // HTTP /runs/:id/resume route turns the throw into a 400) and the run stays
    // suspended — rather than resolving, then failing the run asynchronously
    // inside the pipeline continuation (where handlers re-validates the resumed
    // value). The continuation's validation remains the authoritative one, so we
    // resolve with the original `value`.
    if (pending.outputSchema !== undefined) {
      await validate(pending.outputSchema, value, 'output')
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
        outputSchema?: import('./schema.js').SkelmSchema<unknown>
      } = {
        resolve,
        reject,
        ...(request.outputSchema !== undefined && { outputSchema: request.outputSchema }),
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
  const runId = options.runId ?? generateRunId()
  const resumeFromWaiting = options.resumeFromWaiting
  if (resumeFromWaiting !== undefined && resumeFromWaiting.run.runId !== runId) {
    throw new RunStateError(
      runId,
      `resume source runId ${resumeFromWaiting.run.runId} does not match`,
    )
  }
  const waitingStepId = resumeFromWaiting?.run.waiting?.stepId
  const waitingStepIndex =
    waitingStepId === undefined ? -1 : pipeline.steps.findIndex((step) => step.id === waitingStepId)
  if (resumeFromWaiting !== undefined) {
    if (resumeFromWaiting.run.status !== 'waiting' || waitingStepId === undefined) {
      throw new RunStateError(runId, `run ${runId} is not waiting`)
    }
    if (waitingStepIndex < 0) {
      throw new RunStateError(runId, `waiting step ${waitingStepId} no longer exists`)
    }
  }
  // Unknown executable profile references fail here, before run.created is
  // published or a run record is stored — validation-first, no partial run.
  assertExecutableProfileRefs(
    pipeline.steps,
    options.defaultPermissions,
    options.permissionProfiles,
    options.executableProfiles,
  )
  const startedAt = resumeFromWaiting?.run.startedAt ?? Date.now()
  const events = options.events ?? new EventBus()
  // Subscribe the caller's live listener (if any) to the run's bus. This is how
  // a queue driver's onEvent hook receives step.partial / lifecycle events as
  // the turn streams — see RunOptions.onEvent.
  const unsubscribeOnEvent =
    options.onEvent === undefined ? undefined : events.forRun(runId, options.onEvent)
  const store = options.store
  const stateStore = options.stateStore ?? options.store ?? defaultStateStore
  const threadHost = createThreadHost(stateStore)
  const assetHost = createAssetHost(pipeline.baseDir ?? process.cwd())
  // ArtifactStore is part of the RunStore surface; fall back to the default
  // in-memory store so ctx.artifacts is always available even when the caller
  // didn't wire a durable store.
  const artifactStore: ArtifactStore = options.store ?? defaultStateStore
  const makeArtifactsHandle = (stepId: StepId) =>
    createArtifactsHandle({ artifactStore, events, runId, stepId })
  const storeWrites: Promise<void>[] = []
  const workspaceManager = options.workspaceManager ?? new WorkspaceManager()
  const deferredWorkspaceFinalizers: Array<(status: RunStatus) => Promise<void>> = []
  let currentWorkspace: Context['workspace']
  const auditWrites: Promise<void>[] = []
  const unsubscribeStore = subscribeStoreEvents({ events, runId, store, storeWrites })
  const unsubscribeRunState = subscribeRunStateMirror({ events, runId, store, storeWrites })
  const unsubscribeAudit = subscribeAuditEvents({
    events,
    runId,
    auditWriter: options.auditWriter,
    auditWrites,
  })
  const controller = new AbortController()
  const unsubscribeAbort = bindAbortSignal(options.signal, controller)

  if (resumeFromWaiting === undefined) {
    events.publish({
      type: 'run.created',
      runId,
      pipelineId: pipeline.id,
      input,
      at: startedAt,
    })
    events.publish({ type: 'run.started', runId, at: startedAt })
  }

  // Persist a `running` Run record up-front so a gateway crash leaves a
  // recoverable seed in the store. Without this, events stream out but no
  // Run row exists until finalizeStoredRun() at the end — a mid-run crash
  // would orphan the events and break listRuns({status: 'running'}).
  if (store !== undefined && resumeFromWaiting === undefined) {
    storeWrites.push(
      store.putRun(
        Object.freeze({
          runId,
          pipelineId: pipeline.id,
          ...(options.workflowPath !== undefined && { workflowPath: options.workflowPath }),
          ...(options.triggerId !== undefined && { triggerId: options.triggerId }),
          ...(options.parentRunId !== undefined && { parentRunId: options.parentRunId }),
          ...(options.parentStepId !== undefined && { parentStepId: options.parentStepId }),
          ...(options.taskId !== undefined && { taskId: options.taskId }),
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
  const persistStepResults = (): void => {
    if (store === undefined) return
    storeWrites.push(
      store
        .updateRun(runId, { steps: Object.freeze([...stepResults]) })
        .catch((err) => logStoreFailure('step-results', runId, err)),
    )
  }
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
          ...(options.parentRunId !== undefined && { parentRunId: options.parentRunId }),
          ...(options.parentStepId !== undefined && { parentStepId: options.parentStepId }),
          ...(options.taskId !== undefined && { taskId: options.taskId }),
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
        unsubscribeRunState,
        unsubscribeAudit,
        unsubscribeOnEvent,
      )
    }
  }

  const resumedStepResults = resumeFromWaiting?.run.steps ?? []
  const resumedStepById = new Map(resumedStepResults.map((step) => [step.id, step]))

  for (const [stepIndex, step] of pipeline.steps.entries()) {
    if (resumeFromWaiting !== undefined && stepIndex < waitingStepIndex) {
      const stored = resumedStepById.get(step.id)
      if (stored === undefined) {
        throw new RunStateError(runId, `stored run is missing prior step ${step.id}`)
      }
      if (stored.status !== 'completed' && stored.status !== 'skipped') {
        throw new RunStateError(
          runId,
          `stored prior step ${step.id} has non-resumable status ${stored.status}`,
        )
      }
      stepResults.push(stored)
      if (stored.status === 'completed') stepOutputs[stored.id] = stored.output
      continue
    }

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
        assets: assetHost,
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
        persistStepResults()
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
        persistStepResults()
        events.publish({ type: 'step.skipped', runId, stepId: step.id, kind: step.kind, at })
        continue
      }
    }

    if (step.kind === 'wait' && storeWrites.length > 0) {
      await Promise.all(storeWrites)
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
        assets: assetHost,
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
          ...(options.executableProfiles !== undefined && {
            executableProfiles: options.executableProfiles,
          }),
          ...(options.defaultAgentBackend !== undefined && {
            defaultAgentBackend: options.defaultAgentBackend,
          }),
          ...(options.defaultInferBackend !== undefined && {
            defaultInferBackend: options.defaultInferBackend,
          }),
          ...(options.unrestrictedGrant !== undefined && {
            unrestrictedGrant: options.unrestrictedGrant,
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
          ...(options.agentmemoryHandleFactory !== undefined && {
            agentmemoryHandleFactory: options.agentmemoryHandleFactory,
          }),
          ...(options.pipelineRegistry !== undefined && {
            pipelineRegistry: options.pipelineRegistry,
          }),
          ...(options.delegationCeiling !== undefined && {
            delegationCeiling: options.delegationCeiling,
          }),
          delegationStack: options.delegationStack ?? [pipeline.id],
          delegationDepth: options.delegationDepth ?? 0,
          ...(options.maxDelegationDepth !== undefined && {
            maxDelegationDepth: options.maxDelegationDepth,
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
      persistStepResults()
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
      const runCancelled = err instanceof RunCancelledError || controller.signal.aborted
      const serialized = serializeError(runCancelled ? new RunCancelledError() : err)
      stepResults.push({
        id: step.id,
        kind: step.kind,
        status: 'failed',
        output: undefined,
        startedAt: stepStart,
        completedAt,
        error: serialized,
      })
      persistStepResults()
      events.publish({
        type: 'step.error',
        runId,
        stepId: step.id,
        kind: step.kind,
        error: serialized,
        at: completedAt,
      })
      if (runCancelled) {
        runStatus = 'cancelled'
        runError = serialized
        break
      }
      if (step.continueOnError) {
        if (runStatus === 'running') {
          runStatus = 'failed'
          runError = serialized
        }
        continue
      }
      runStatus = 'failed'
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
        assets: assetHost,
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
      ...(options.parentRunId !== undefined && { parentRunId: options.parentRunId }),
      ...(options.parentStepId !== undefined && { parentStepId: options.parentStepId }),
      ...(options.taskId !== undefined && { taskId: options.taskId }),
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
    unsubscribeRunState,
    unsubscribeAudit,
    unsubscribeOnEvent,
  )
}

// Validates every statically-declared executableProfiles reference — project
// defaults, the named permission profile a step selects, and step-level
// permissions — against the trust-boundary-supplied definitions. forEach
// children are factories and cannot be walked here; they stay covered by the
// per-step resolvePermissions backstop.
function assertExecutableProfileRefs(
  steps: readonly Step[],
  defaults: AgentPermissions | undefined,
  profiles: Readonly<Record<string, AgentPermissions>> | undefined,
  definitions: Readonly<Record<string, ExecutableProfileDefinition>> | undefined,
): void {
  const checkPermissions = (permissions: AgentPermissions | undefined): void => {
    if (permissions === undefined) return
    for (const name of permissions.executableProfiles ?? []) {
      if (definitions?.[name] === undefined) throw new UnknownExecutableProfileError(name)
    }
    const named = permissions.profile === undefined ? undefined : profiles?.[permissions.profile]
    for (const name of named?.executableProfiles ?? []) {
      if (definitions?.[name] === undefined) throw new UnknownExecutableProfileError(name)
    }
  }
  checkPermissions(defaults)
  const visit = (step: Step): void => {
    checkPermissions((step as { permissions?: AgentPermissions }).permissions)
    switch (step.kind) {
      case 'parallel':
        for (const child of step.steps) visit(child)
        return
      case 'branch':
        for (const child of Object.values(step.cases)) visit(child as Step)
        if (step.default !== undefined) visit(step.default)
        return
      case 'loop':
      case 'idempotent':
        visit(step.step)
        return
      case 'pipelineStep':
        for (const child of step.pipeline.steps) visit(child)
        return
      default:
        return
    }
  }
  for (const step of steps) visit(step)
}

export { SchemaValidationError }
