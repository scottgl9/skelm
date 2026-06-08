import { constants } from 'node:fs'
import { mkdir, open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
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
  type AuditEvent,
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
import { EventBus, type EventListener } from './events.js'
import { runStepWithRetry } from './execution/handlers.js'
import type { ExecutionRuntime } from './execution/runtime.js'
import { extractJsonFromText, tryParseJson } from './json-utils.js'
import { createMcpHost } from './mcp/host.js'
import type {
  AgentPermissions,
  NetworkPolicy,
  PermissionDimension,
  ResolvedPolicy,
} from './permissions.js'
import {
  ALL_PERMISSION_DIMENSIONS,
  TrustEnforcer,
  createPolicyFetch,
  resolvePermissions,
} from './permissions.js'
import {
  ArtifactMaterializationError,
  type ArtifactStore,
  type ArtifactStoreHandle,
  ArtifactValidationError,
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

/**
 * Write an audit entry, surfacing (not swallowing) a writer failure. The audit
 * log is the durable record of every privileged decision, so a silent write
 * failure would let a denial / bypass / tool call vanish from the record with no
 * operator signal. We still must not poison the run — a failing AuditWriter
 * cannot abort execution — so the returned promise always resolves, but the
 * failure is logged to stderr. Returns the (resolved) promise so callers that
 * track audit writes (and await them before exit) keep working.
 */
function writeAudit(writer: AuditWriter, entry: AuditEvent): Promise<void> {
  return writer.write(entry).catch((err) => {
    const detail = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `[skelm audit] write failed (action=${entry.action} run=${entry.runId ?? '-'}): ${detail}\n`,
    )
  })
}

/**
 * Surface a swallowed run-store write failure to stderr. The wait/resume status
 * writes are load-bearing: if the `waiting` flip is lost, the gateway's
 * recoverInterruptedRuns() sees a parked run as `running` and finalizes it as
 * crashed on the next restart. Swallowing the failure made that divergence
 * invisible. We still don't poison the run (the write is best-effort tracked in
 * storeWrites), but the operator now sees the failure.
 */
function logStoreFailure(label: string, runId: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  process.stderr.write(`[skelm run-store] ${label} write failed for run ${runId}: ${detail}\n`)
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
  const startedAt = resumeFromWaiting?.run.startedAt ?? Date.now()
  const events = options.events ?? new EventBus()
  // Subscribe the caller's live listener (if any) to the run's bus. This is how
  // a queue driver's onEvent hook receives step.partial / lifecycle events as
  // the turn streams — see RunOptions.onEvent.
  const unsubscribeOnEvent =
    options.onEvent === undefined ? undefined : events.subscribe(options.onEvent)
  const store = options.store
  const stateStore = options.stateStore ?? options.store ?? defaultStateStore
  const threadHost = createThreadHost(stateStore)
  const assetHost = createAssetHost(pipeline.baseDir ?? process.cwd())
  // ArtifactStore is part of the RunStore surface; fall back to the default
  // in-memory store so ctx.artifacts is always available even when the caller
  // didn't wire a durable store.
  const artifactStore: ArtifactStore = options.store ?? defaultStateStore
  const makeArtifactsHandle = (
    stepId: StepId,
    materializationRoot?: string,
  ): ArtifactStoreHandle & { withWorkspacePath(path: string): ArtifactStoreHandle } => ({
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
    materialize: async (ref, opts = {}) => {
      const workspacePath = materializationRoot
      if (workspacePath === undefined) {
        throw new ArtifactMaterializationError(
          'ctx.artifacts.materialize requires the current step to declare a workspace',
        )
      }
      const startedAt = Date.now()
      if (ref.runId !== runId) {
        throw new ArtifactMaterializationError(
          `artifact ${ref.artifactId} belongs to run ${ref.runId}, not current run ${runId}`,
        )
      }
      const found = await artifactStore.getArtifact(ref)
      if (found === null) {
        throw new ArtifactMaterializationError(
          `artifact ${ref.artifactId} was not found for run ${ref.runId}`,
        )
      }
      if (opts.maxBytes !== undefined && found.data.byteLength > opts.maxBytes) {
        throw new ArtifactMaterializationError(
          `artifact ${ref.artifactId} is ${found.data.byteLength} bytes, exceeding maxBytes ${opts.maxBytes}`,
        )
      }
      const relativePath = opts.path ?? found.descriptor.name
      const path = await resolveArtifactMaterializationPath(workspacePath, relativePath)
      await assertMaterializationTargetAllowed(workspacePath, path)
      await mkdir(dirname(path), { recursive: true })
      await assertMaterializationTargetAllowed(workspacePath, path)
      if (opts.overwrite === true) {
        const file = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
          0o644,
        )
        try {
          await file.writeFile(found.data)
        } finally {
          await file.close()
        }
      } else {
        try {
          const file = await open(path, 'wx')
          try {
            await file.writeFile(found.data)
          } finally {
            await file.close()
          }
        } catch (err) {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as NodeJS.ErrnoException).code === 'EEXIST'
          ) {
            throw new ArtifactMaterializationError(
              `artifact target already exists (use overwrite: true to replace): ${relativePath}`,
            )
          }
          throw err
        }
      }
      events.publish({
        type: 'tool.result',
        runId,
        stepId,
        tool: 'artifacts.materialize',
        result: {
          artifactId: found.descriptor.artifactId,
          name: found.descriptor.name,
          mimeType: found.descriptor.mimeType,
          size: found.descriptor.size,
          path: relativePath,
          bytesWritten: found.data.byteLength,
        },
        durationMs: Date.now() - startedAt,
        at: Date.now(),
      })
      return {
        descriptor: found.descriptor,
        path,
        bytesWritten: found.data.byteLength,
      }
    },
    withWorkspacePath: (path) => makeArtifactsHandle(stepId, path),
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
  // Mirror wait/resume into the persisted Run record so HTTP clients can
  // detect pause from a single GET /runs/:id, without a second event-log
  // fetch. The runner publishes run.waiting / run.resumed; the in-process
  // ExecutionStore (if any) tracks the snapshot on the Run row. The Run
  // object captured at finalize-time will reflect a final cleared state.
  const unsubscribeRunState =
    store === undefined
      ? undefined
      : events.subscribe((event) => {
          if (event.type === 'run.waiting') {
            // Persist BOTH the waiting snapshot AND the 'waiting' status. Without
            // the status flip, a wait-paused run looks like 'running' to the
            // gateway's recoverInterruptedRuns() at restart and gets finalized as
            // failed (RunCrashedError) — silently killing parked runs on every
            // gateway bounce. The status is restored to 'running' on resume so
            // the rest of the run executes as before.
            storeWrites.push(
              store
                .updateRun(event.runId, {
                  status: 'waiting',
                  waiting: {
                    stepId: event.stepId,
                    ...(event.message !== undefined && { message: event.message }),
                    ...(event.timeoutMs !== undefined && { timeoutMs: event.timeoutMs }),
                    since: event.at,
                  },
                })
                .catch((err) => logStoreFailure('waiting-status', event.runId, err)),
            )
          } else if (event.type === 'run.resumed') {
            storeWrites.push(
              store
                .updateRun(event.runId, { status: 'running', waiting: undefined })
                .catch((err) => logStoreFailure('resume-status', event.runId, err)),
            )
          }
        })

  // Bridge permission denials and MCP tool dispatch into the audit log.
  // This is the single audit subscription for one run. It is unsubscribed at
  // finalization so shared gateway buses do not accumulate duplicate writers.
  // Writes are tracked alongside storeWrites so the run waits for fsync before
  // returning — otherwise a fast-failing CLI exit could drop the entry.
  const auditWriter = options.auditWriter
  const auditWrites: Promise<void>[] = []
  const unsubscribeAudit =
    auditWriter === undefined
      ? undefined
      : events.subscribe((event) => {
          const queue = (entry: { action: string; details: Record<string, unknown> }) => {
            auditWrites.push(
              writeAudit(auditWriter, {
                ...(event.runId !== undefined && { runId: event.runId }),
                actor: 'runtime',
                action: entry.action,
                details: entry.details,
              }),
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
          } else if (event.type === 'permission.bypassed') {
            // Per-dimension fan-out so `skelm audit query` can enumerate
            // exactly what an operator-granted bypass enabled.
            auditWrites.push(
              writeAudit(auditWriter, {
                ...(event.runId !== undefined && { runId: event.runId }),
                actor: 'step-author',
                action: 'permission.bypassed',
                details: {
                  stepId: event.stepId,
                  detail: event.detail,
                  at: event.at,
                  dimensions: [...ALL_PERMISSION_DIMENSIONS],
                },
              }),
            )
            for (const dimension of ALL_PERMISSION_DIMENSIONS) {
              auditWrites.push(
                writeAudit(auditWriter, {
                  ...(event.runId !== undefined && { runId: event.runId }),
                  actor: 'step-author',
                  action: `permission.bypass.${dimension}`,
                  details: { stepId: event.stepId, dimension, at: event.at },
                }),
              )
            }
          } else if (event.type === 'secret.not_found') {
            queue({
              action: 'secret.not_found',
              details: { stepId: event.stepId, name: event.name, at: event.at },
            })
          } else if (event.type === 'backend.failover') {
            queue({
              action: 'backend.failover',
              details: {
                stepId: event.stepId,
                kind: event.kind,
                from: event.from,
                to: event.to,
                error: event.error,
                at: event.at,
              },
            })
          } else if (event.type === 'tool.call') {
            queue({
              action: 'tool.call',
              details: { stepId: event.stepId, tool: event.tool, at: event.at },
            })
          } else if (event.type === 'tool.result') {
            queue({
              action: 'tool.result',
              details: {
                stepId: event.stepId,
                tool: event.tool,
                durationMs: event.durationMs,
                at: event.at,
              },
            })
          }
        })
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

export { SchemaValidationError }

async function resolveArtifactMaterializationPath(
  root: string,
  requested: string,
): Promise<string> {
  if (requested.length === 0 || requested.includes('\0')) {
    throw new ArtifactValidationError('artifact materialization path must be a non-empty path')
  }
  if (isAbsolute(requested)) {
    throw new ArtifactValidationError('artifact materialization path must be relative')
  }
  for (const segment of requested.split(/[\\/]+/)) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ArtifactValidationError(
        'artifact materialization path must not contain empty, dot, or parent segments',
      )
    }
  }
  const path = resolve(root, requested)
  assertInsideRoot(root, path, 'artifact materialization path must stay inside the workspace')
  return path
}

async function assertMaterializationTargetAllowed(root: string, path: string): Promise<void> {
  const rootReal = await realpath(root)
  const parentReal = await realpathNearestExistingParent(path)
  assertInsideRoot(rootReal, parentReal, 'artifact materialization parent escapes the workspace')
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      throw new ArtifactValidationError('artifact materialization target must be a file')
    }
    const targetReal = await realpath(path)
    assertInsideRoot(rootReal, targetReal, 'artifact materialization target escapes the workspace')
  } catch (error) {
    if (isMissingPath(error)) return
    throw error
  }
}

async function realpathNearestExistingParent(path: string): Promise<string> {
  let current = dirname(path)
  while (true) {
    try {
      return await realpath(current)
    } catch (error) {
      if (!isMissingPath(error)) throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

function assertInsideRoot(root: string, path: string, message: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  throw new ArtifactValidationError(message)
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function finalizeStoredRun<TRun extends Run>(
  run: TRun,
  store: RunStore | undefined,
  storeWrites: Promise<void>[],
  unsubscribeStore: (() => void) | undefined,
  auditWrites: Promise<void>[] = [],
  unsubscribeAbort?: () => void,
  unsubscribeRunState?: () => void,
  unsubscribeAudit?: () => void,
  unsubscribeOnEvent?: () => void,
): Promise<TRun> {
  try {
    await Promise.all(storeWrites)
    await Promise.all(auditWrites)
    await store?.putRun(run)
    return run
  } finally {
    unsubscribeStore?.()
    unsubscribeRunState?.()
    unsubscribeAudit?.()
    unsubscribeOnEvent?.()
    unsubscribeAbort?.()
  }
}
