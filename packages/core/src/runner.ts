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
  NoopAuditWriter,
  type SecretResolver,
} from './enforcement/index.js'
import { RunCancelledError, WaitTimeoutError, serializeError } from './errors.js'
import { EventBus } from './events.js'
import { createMcpHost } from './mcp/host.js'
import type { AgentPermissions, PermissionDimension } from './permissions.js'
import { TrustEnforcer, resolvePermissions } from './permissions.js'
import { MemoryRunStore, type RunStore } from './run-store.js'
import { SchemaValidationError, validate } from './schema.js'
import { createStateHandle } from './state.js'
import type {
  Context,
  Pipeline,
  Run,
  RunMetadata,
  RunStatus,
  Step,
  StepId,
  StepResult,
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
  stateStore?: RunStore
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
}

export class ApprovalDeniedError extends Error {
  constructor(
    readonly stepId: string,
    readonly approver?: string,
    readonly reason?: string,
  ) {
    super(`approval denied for step "${stepId}"${reason ? `: ${reason}` : ''}`)
    this.name = 'ApprovalDeniedError'
  }
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

interface ExecutionRuntime {
  readonly workspaceManager: WorkspaceManager
  readonly stateStore: RunStore
  readonly store?: RunStore
  readonly defaultPermissions?: AgentPermissions
  readonly permissionProfiles?: Readonly<Record<string, AgentPermissions>>
  readonly approvalGate?: ApprovalGate
  readonly currentWorkspace: Context['workspace']
  setCurrentWorkspace(workspace: Context['workspace']): void
  deferRunWorkspaceFinalizer(finalizer: (status: RunStatus) => Promise<void>): void
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
      throw new Error(`run ${runId} is not waiting`)
    }
    this.pendingWaits.delete(runId)
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer)
    }
    pending.resolve(value)
  }

  private awaitResume(request: WaitRequest): Promise<unknown> {
    if (this.pendingWaits.has(request.runId)) {
      throw new Error(`run ${request.runId} is already waiting`)
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
  const storeWrites: Promise<void>[] = []
  const workspaceManager = options.workspaceManager ?? new WorkspaceManager()
  const deferredWorkspaceFinalizers: Array<(status: RunStatus) => Promise<void>> = []
  let currentWorkspace: Context['workspace']
  const unsubscribeStore =
    store === undefined
      ? undefined
      : events.subscribe((event) => {
          storeWrites.push(store.appendEvent(event))
        })
  const controller = new AbortController()
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason)
    } else {
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), {
        once: true,
      })
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
      resolvedInput = await validate(pipeline.inputSchema, input, 'input')
    } catch (err) {
      runStatus = 'failed'
      runError = serializeError(err)
      const completedAt = Date.now()
      events.publish({ type: 'run.failed', runId, error: runError, at: completedAt })
      return await finalizeStoredRun(
        Object.freeze({
          runId,
          pipelineId: pipeline.id,
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
      )
    }
  }

  for (const step of pipeline.steps) {
    if (controller.signal.aborted) {
      runStatus = 'cancelled'
      runError = serializeError(new RunCancelledError())
      break
    }

    const stepStart = Date.now()
    events.publish({ type: 'step.start', runId, stepId: step.id, kind: step.kind, at: stepStart })
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
        ...(currentWorkspace !== undefined && { workspace: currentWorkspace }),
      })
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
          currentWorkspace,
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
        ...(currentWorkspace !== undefined && { workspace: currentWorkspace }),
      })
      if (pipeline.finalize) {
        finalOutput = await pipeline.finalize(ctx)
      } else {
        finalOutput = adoptLastStepOutput<TOutput>(stepResults)
      }
      if (pipeline.outputSchema !== undefined && finalOutput !== undefined) {
        finalOutput = await validate(pipeline.outputSchema, finalOutput, 'output')
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
  )
}

export { SchemaValidationError }

async function runStepWithRetry(
  step: Step,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events: EventBus,
  runtime: ExecutionRuntime,
): Promise<unknown> {
  const maxAttempts = step.retry?.maxAttempts ?? 1
  const backoffMultiplier = step.retry?.backoffMultiplier ?? 1
  let delayMs = step.retry?.delayMs ?? 0
  let attempt = 1

  while (true) {
    try {
      return await runStep(step, ctx, backends, waitForInput, events, runtime)
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryableError(err)) {
        throw err
      }
      events.publish({
        type: 'step.retry',
        runId: ctx.run.runId,
        stepId: step.id,
        kind: step.kind,
        attempt,
        error: serializeError(err),
        ...(delayMs > 0 && { delayMs }),
        at: Date.now(),
      })
      if (delayMs > 0) {
        await sleep(delayMs, ctx.signal)
      }
      attempt += 1
      delayMs *= backoffMultiplier
    }
  }
}

async function finalizeStoredRun<TRun extends Run>(
  run: TRun,
  store: RunStore | undefined,
  storeWrites: Promise<void>[],
  unsubscribeStore: (() => void) | undefined,
): Promise<TRun> {
  try {
    await Promise.all(storeWrites)
    await store?.putRun(run)
    return run
  } finally {
    unsubscribeStore?.()
  }
}

function collectDeclaredPermissionDimensions(
  permissions: AgentPermissions | undefined,
  mcpServers: readonly unknown[] | undefined,
): ReadonlySet<PermissionDimension> {
  const declared = new Set<PermissionDimension>()
  if (permissions?.allowedTools !== undefined || permissions?.deniedTools !== undefined)
    declared.add('tool')
  if (permissions?.allowedExecutables !== undefined) declared.add('executable')
  if (permissions?.allowedMcpServers !== undefined || (mcpServers?.length ?? 0) > 0)
    declared.add('mcp')
  if (permissions?.allowedSkills !== undefined) declared.add('skill')
  if (permissions?.networkEgress !== undefined) declared.add('network')
  if (permissions?.fsRead !== undefined) declared.add('fs.read')
  if (permissions?.fsWrite !== undefined) declared.add('fs.write')
  return declared
}

function assertBackendSupportsPermissions(
  stepId: string,
  backend: SkelmBackend,
  declared: ReadonlySet<PermissionDimension>,
): void {
  const unresolved = new Set(declared)
  if (backend.capabilities.mcp) {
    unresolved.delete('mcp')
  }
  if (unresolved.size === 0) return

  if (backend.capabilities.toolPermissions === 'unsupported') {
    throw new BackendCapabilityError(
      `backend ${backend.id} cannot enforce declared permissions for step "${stepId}"`,
      backend.id,
      'toolPermissions',
    )
  }

  if (backend.capabilities.toolPermissions !== 'wrapped') return

  const unsupported = [...unresolved].filter(
    (dimension) => !['tool', 'executable'].includes(dimension),
  )
  if (unsupported.length === 0) return

  throw new BackendCapabilityError(
    `backend ${backend.id} cannot enforce ${unsupported.join(', ')} permissions in wrapped mode for step "${stepId}"`,
    backend.id,
    'toolPermissions',
  )
}

async function runStep(
  step: Step,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput?: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<unknown> {
  switch (step.kind) {
    case 'code':
      return await step.run(ctx)
    case 'llm': {
      if (!backends) {
        throw new BackendNotFoundError(
          `step "${step.id}" requires a backend registry but none was provided to runPipeline()`,
        )
      }
      const backend = backends.resolveForLlm({ backendId: step.backend })
      const promptText = typeof step.prompt === 'function' ? step.prompt(ctx) : step.prompt
      const systemText =
        step.system === undefined
          ? undefined
          : typeof step.system === 'function'
            ? step.system(ctx)
            : step.system
      const req = {
        messages: [{ role: 'user' as const, content: promptText }],
        ...(systemText !== undefined && { system: systemText }),
        ...(step.model !== undefined && { model: step.model }),
        ...(step.temperature !== undefined && { temperature: step.temperature }),
        ...(step.maxTokens !== undefined && { maxTokens: step.maxTokens }),
        ...(step.outputSchema !== undefined && { outputSchema: step.outputSchema }),
      }
      // biome-ignore lint/style/noNonNullAssertion: capability checked in resolveForLlm
      const response = await backend.infer!(req, { signal: ctx.signal })
      if (step.outputSchema !== undefined) {
        const candidate = response.structured ?? response.text
        return await validate(step.outputSchema, candidate, 'output')
      }
      return { text: response.text ?? '', usage: response.usage }
    }
    case 'agent': {
      if (!backends) {
        throw new BackendNotFoundError(
          `step "${step.id}" requires a backend registry but none was provided to runPipeline()`,
        )
      }
      const backend = backends.resolveForAgent({ backendId: step.backend })
      let preparedWorkspace: Awaited<ReturnType<WorkspaceManager['prepare']>> | undefined
      let finishedWorkspace = false
      try {
        const workspaceConfig =
          step.workspace === undefined
            ? undefined
            : typeof step.workspace === 'function'
              ? step.workspace(ctx)
              : step.workspace
        preparedWorkspace =
          workspaceConfig === undefined
            ? undefined
            : await runtime?.workspaceManager.prepare({
                pipelineId: ctx.run.pipelineId,
                runId: ctx.run.runId,
                workspace: workspaceConfig,
              })
        const workspaceCtx =
          preparedWorkspace === undefined
            ? ctx
            : freezeContext({
                ...ctx,
                workspace: preparedWorkspace.handle,
              })
        const resolvedPromptText =
          typeof step.prompt === 'function' ? step.prompt(workspaceCtx) : step.prompt
        const resolvedSystemText =
          step.system === undefined
            ? undefined
            : typeof step.system === 'function'
              ? step.system(workspaceCtx)
              : step.system
        const mcpServers =
          step.mcp === undefined
            ? undefined
            : typeof step.mcp === 'function'
              ? step.mcp(workspaceCtx)
              : step.mcp
        const policy =
          step.permissions !== undefined ||
          mcpServers !== undefined ||
          preparedWorkspace !== undefined
            ? resolvePermissions(
                runtime?.defaultPermissions,
                applyWorkspacePermissions(step.permissions, preparedWorkspace?.handle.path),
                runtime?.permissionProfiles,
              )
            : undefined
        if (policy !== undefined && mcpServers !== undefined) {
          const enforcer = new TrustEnforcer(policy)
          for (const server of mcpServers) {
            const decision = enforcer.canAttachMcpServer(server.id)
            if (!decision.allow) {
              throw new Error(
                `step "${step.id}" is not allowed to attach MCP server "${server.id}" (${decision.reason})`,
              )
            }
          }
        }
        if (mcpServers !== undefined && mcpServers.length > 0 && !backend.capabilities.mcp) {
          throw new BackendCapabilityError(
            `backend ${backend.id} does not support per-step MCP attachments`,
            backend.id,
            'mcp',
          )
        }
        const declaredPermissionDimensions = collectResolvedPermissionDimensions(policy, mcpServers)
        assertBackendSupportsPermissions(step.id, backend, declaredPermissionDimensions)
        if (policy?.approval && runtime?.approvalGate !== undefined) {
          const decision = await runtime.approvalGate.request({
            runId: ctx.run.runId,
            stepId: step.id,
            action: 'agent.start',
            context: Object.freeze({
              dimensions: Array.from(policy.approval.on),
              mcpServers: mcpServers?.map((m) => m.id) ?? [],
            }),
          })
          if (!decision.approved) {
            throw new ApprovalDeniedError(step.id, decision.approver, decision.reason)
          }
        }
        const req: AgentRequest = {
          prompt: resolvedPromptText,
          ...(resolvedSystemText !== undefined && { system: resolvedSystemText }),
          ...(step.maxTurns !== undefined && { maxTurns: step.maxTurns }),
          ...(preparedWorkspace !== undefined && { cwd: preparedWorkspace.handle.path }),
          ...(policy !== undefined && { permissions: policy }),
          ...(mcpServers !== undefined && { mcpServers }),
          ...(step.outputSchema !== undefined && { outputSchema: step.outputSchema }),
        }
        const mcpHost =
          mcpServers !== undefined &&
          mcpServers.length > 0 &&
          backend.capabilities.toolPermissions === 'wrapped'
            ? await createMcpHost(mcpServers, {
                ...(policy !== undefined && { enforcer: new TrustEnforcer(policy) }),
                ...(events !== undefined && { events }),
                runId: ctx.run.runId,
                stepId: step.id,
              })
            : undefined
        try {
          // biome-ignore lint/style/noNonNullAssertion: capability checked in resolveForAgent
          const response = await backend.run!(req, {
            signal: ctx.signal,
            ...(policy !== undefined && { permissions: policy }),
            ...(mcpHost !== undefined && { mcpHost }),
          })
          const candidate =
            step.outputSchema !== undefined ? (response.structured ?? response.text) : undefined
          const result =
            step.outputSchema !== undefined
              ? await validate(step.outputSchema, candidate, 'output')
              : {
                  text: response.text ?? '',
                  ...(response.usage !== undefined && { usage: response.usage }),
                  ...(response.stopReason !== undefined && { stopReason: response.stopReason }),
                }
          await preparedWorkspace?.finishStep('completed')
          finishedWorkspace = true
          if (preparedWorkspace !== undefined) {
            const finalizedWorkspace = preparedWorkspace
            runtime?.setCurrentWorkspace(
              finalizedWorkspace.exposeAfterStep ? finalizedWorkspace.handle : undefined,
            )
            runtime?.deferRunWorkspaceFinalizer((status) => finalizedWorkspace.finishRun(status))
          }
          return result
        } finally {
          await mcpHost?.dispose()
        }
      } catch (error) {
        if (!finishedWorkspace) {
          await preparedWorkspace?.finishStep('failed')
        }
        throw error
      }
    }
    case 'idempotent':
      return await runIdempotent(step, ctx, backends, waitForInput, events, runtime)
    case 'parallel':
      return await runParallel(step, ctx, backends, waitForInput, events, runtime)
    case 'forEach':
      return await runForEach(step, ctx, backends, waitForInput, events, runtime)
    case 'branch':
      return await runBranch(step, ctx, backends, waitForInput, events, runtime)
    case 'loop':
      return await runLoop(step, ctx, backends, waitForInput, events, runtime)
    case 'wait':
      return await runWait(step, ctx, waitForInput, events)
    case 'pipelineStep':
      return await runPipelineStep(step, ctx, backends, waitForInput, events, runtime)
    default: {
      const exhaustive: never = step
      throw new Error(`unknown step kind: ${(exhaustive as { kind: string }).kind}`)
    }
  }
}

async function runParallel(
  step: Extract<Step, { kind: 'parallel' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<Record<string, unknown>> {
  const onError = step.onError ?? 'fail'
  const settled = await Promise.allSettled(
    step.steps.map((child) =>
      runStep(child, ctx, backends, waitForInput, events, createDetachedWorkspaceRuntime(runtime)),
    ),
  )
  const out: Record<string, unknown> = {}
  for (let i = 0; i < step.steps.length; i++) {
    const child = step.steps[i]
    const r = settled[i]
    if (child === undefined || r === undefined) continue
    if (r.status === 'fulfilled') {
      out[child.id] = r.value
    } else {
      if (onError === 'fail') {
        throw r.reason
      }
      // continue / partial: record the error shape; the run does not abort.
      out[child.id] = { error: serializeError(r.reason) }
    }
  }
  return out
}

async function runIdempotent(
  step: Extract<Step, { kind: 'idempotent' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<unknown> {
  const state = createStateHandle(runtime?.stateStore ?? defaultStateStore, {
    pipelineId: ctx.run.pipelineId,
    stepId: step.id,
    ...(step.state !== undefined && { config: step.state }),
  })
  const key = idempotentStateKey(resolveIdempotentKey(step.key, ctx))
  const cached = await state.get<{ value: unknown }>(key)
  if (cached !== undefined) {
    return cached.value
  }
  const value = await runStepWithRetry(
    step.step,
    ctx,
    backends,
    waitForInput,
    events ?? new EventBus(),
    {
      workspaceManager: runtime?.workspaceManager ?? new WorkspaceManager(),
      stateStore: runtime?.stateStore ?? defaultStateStore,
      ...(runtime?.store !== undefined && { store: runtime.store }),
      ...(runtime?.defaultPermissions !== undefined && {
        defaultPermissions: runtime.defaultPermissions,
      }),
      ...(runtime?.permissionProfiles !== undefined && {
        permissionProfiles: runtime.permissionProfiles,
      }),
      currentWorkspace: runtime?.currentWorkspace,
      setCurrentWorkspace: (workspace) => runtime?.setCurrentWorkspace(workspace),
      deferRunWorkspaceFinalizer: (finalizer) => runtime?.deferRunWorkspaceFinalizer(finalizer),
    },
  )
  await state.set(key, { value }, { ...(step.ttlMs !== undefined && { ttlMs: step.ttlMs }) })
  return value
}

async function runForEach(
  step: Extract<Step, { kind: 'forEach' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<unknown[]> {
  const items = step.items(ctx)
  const concurrency = step.concurrency ?? 1
  const results = new Array<unknown>(items.length)
  let cursor = 0
  const workers: Promise<void>[] = []
  const launch = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++
      const item = items[i]
      const child = step.step(item, i)
      results[i] = await runStep(
        child,
        ctx,
        backends,
        waitForInput,
        events,
        createDetachedWorkspaceRuntime(runtime),
      )
    }
  }
  const lanes = Math.min(concurrency, items.length || 1)
  for (let n = 0; n < lanes; n++) {
    workers.push(launch())
  }
  await Promise.all(workers)
  return results
}

async function runBranch(
  step: Extract<Step, { kind: 'branch' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<unknown> {
  const key = step.on(ctx)
  const chosen = step.cases[key] ?? step.default
  if (chosen === undefined) {
    throw new Error(`branch(${step.id}): no case matched "${key}" and no default was provided`)
  }
  return await runStep(chosen, ctx, backends, waitForInput, events, runtime)
}

async function runLoop(
  step: Extract<Step, { kind: 'loop' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<{ iterations: unknown[]; last: unknown }> {
  const iterations: unknown[] = []
  let last: unknown
  for (let i = 0; i < step.maxIterations; i++) {
    if (!(await step.while(ctx))) break
    last = await runStep(step.step, ctx, backends, waitForInput, events, runtime)
    iterations.push(last)
  }
  return { iterations, last }
}

async function runWait(
  step: Extract<Step, { kind: 'wait' }>,
  ctx: Context,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
): Promise<unknown> {
  if (!waitForInput) {
    throw new Error(
      `wait(${step.id}): no wait handler configured; use Runner.start() or pass waitForInput to runPipeline()`,
    )
  }
  const message =
    step.message === undefined
      ? undefined
      : typeof step.message === 'function'
        ? step.message(ctx)
        : step.message
  events?.publish({
    type: 'run.waiting',
    runId: ctx.run.runId,
    stepId: step.id,
    ...(message !== undefined && { message }),
    ...(step.timeoutMs !== undefined && { timeoutMs: step.timeoutMs }),
    at: Date.now(),
  })
  const resumed = await waitForInput({
    runId: ctx.run.runId,
    pipelineId: ctx.run.pipelineId,
    stepId: step.id,
    signal: ctx.signal,
    ...(message !== undefined && { message }),
    ...(step.timeoutMs !== undefined && { timeoutMs: step.timeoutMs }),
    ...(step.outputSchema !== undefined && { outputSchema: step.outputSchema }),
  })
  events?.publish({
    type: 'run.resumed',
    runId: ctx.run.runId,
    stepId: step.id,
    output: resumed,
    at: Date.now(),
  })
  if (step.outputSchema !== undefined) {
    return await validate(step.outputSchema, resumed, 'output')
  }
  return resumed
}

async function runPipelineStep(
  step: Extract<Step, { kind: 'pipelineStep' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<unknown> {
  const nestedInput =
    step.input === undefined
      ? ctx.input
      : typeof step.input === 'function'
        ? step.input(ctx)
        : step.input
  const nestedRun = await runPipeline(step.pipeline, nestedInput, {
    signal: ctx.signal,
    ...(events !== undefined && { events }),
    ...(backends !== undefined && { backends }),
    ...(runtime?.store !== undefined && { store: runtime.store }),
    ...(runtime?.stateStore !== undefined && { stateStore: runtime.stateStore }),
    ...(runtime?.defaultPermissions !== undefined && {
      defaultPermissions: runtime.defaultPermissions,
    }),
    ...(runtime?.permissionProfiles !== undefined && {
      permissionProfiles: runtime.permissionProfiles,
    }),
    ...(runtime?.workspaceManager !== undefined && { workspaceManager: runtime.workspaceManager }),
    ...(waitForInput !== undefined && { waitForInput }),
  })
  if (nestedRun.status === 'completed') {
    return nestedRun.output
  }
  if (nestedRun.status === 'cancelled') {
    throw new RunCancelledError(
      `pipelineStep(${step.id}): nested pipeline "${step.pipeline.id}" was cancelled`,
    )
  }
  throw restoreSerializedError(
    nestedRun.error,
    `pipelineStep(${step.id}): nested pipeline "${step.pipeline.id}" did not complete`,
  )
}

function freezeContext<TInput>(ctx: Context<TInput>): Context<TInput> {
  Object.freeze(ctx.steps)
  return Object.freeze(ctx)
}

function adoptLastStepOutput<TOutput>(stepResults: readonly StepResult[]): TOutput | undefined {
  if (stepResults.length === 0) {
    return undefined
  }
  return stepResults[stepResults.length - 1]?.output as TOutput | undefined
}

function applyWorkspacePermissions(
  permissions: AgentPermissions | undefined,
  workspacePath: string | undefined,
): AgentPermissions | undefined {
  if (workspacePath === undefined) return permissions
  const next: AgentPermissions = {
    ...permissions,
    fsRead: uniqueStrings([workspacePath, ...(permissions?.fsRead ?? [])]),
    fsWrite: uniqueStrings([workspacePath, ...(permissions?.fsWrite ?? [])]),
  }
  return next
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

function createDetachedWorkspaceRuntime(
  runtime: ExecutionRuntime | undefined,
): ExecutionRuntime | undefined {
  if (runtime === undefined) return undefined
  let currentWorkspace = runtime.currentWorkspace
  return {
    workspaceManager: runtime.workspaceManager,
    stateStore: runtime.stateStore,
    ...(runtime.store !== undefined && { store: runtime.store }),
    ...(runtime.defaultPermissions !== undefined && {
      defaultPermissions: runtime.defaultPermissions,
    }),
    ...(runtime.permissionProfiles !== undefined && {
      permissionProfiles: runtime.permissionProfiles,
    }),
    currentWorkspace,
    setCurrentWorkspace: (workspace) => {
      currentWorkspace = workspace
    },
    deferRunWorkspaceFinalizer: runtime.deferRunWorkspaceFinalizer,
  }
}

function resolveIdempotentKey(key: string | ((ctx: Context) => string), ctx: Context): string {
  const resolved = typeof key === 'function' ? key(ctx) : key
  if (resolved.trim().length === 0) {
    throw new Error('idempotent(): key must resolve to a non-empty string')
  }
  return resolved
}

function idempotentStateKey(key: string): string {
  return `idempotent:${key}`
}

function collectResolvedPermissionDimensions(
  policy: ReturnType<typeof resolvePermissions> | undefined,
  mcpServers: readonly unknown[] | undefined,
): ReadonlySet<PermissionDimension> {
  const declared = new Set<PermissionDimension>()
  if (policy === undefined) {
    if ((mcpServers?.length ?? 0) > 0) declared.add('mcp')
    return declared
  }
  if (
    policy.allowedTools.exact.size > 0 ||
    policy.allowedTools.prefixes.length > 0 ||
    policy.allowedTools.star ||
    policy.deniedTools.exact.size > 0 ||
    policy.deniedTools.prefixes.length > 0 ||
    policy.deniedTools.star
  ) {
    declared.add('tool')
  }
  if (policy.allowedExecutables.size > 0) declared.add('executable')
  if (policy.allowedMcpServers.size > 0 || (mcpServers?.length ?? 0) > 0) declared.add('mcp')
  if (policy.allowedSkills.size > 0) declared.add('skill')
  if (policy.networkEgress === 'allow' || typeof policy.networkEgress === 'object') {
    declared.add('network')
  }
  if (policy.fsRead.size > 0) declared.add('fs.read')
  if (policy.fsWrite.size > 0) declared.add('fs.write')
  return declared
}

function generateRunId(): string {
  // Node 19+ exposes globalThis.crypto.randomUUID().
  return crypto.randomUUID()
}

function restoreSerializedError(error: Run['error'], fallbackMessage: string): Error {
  const restored = new Error(error?.message ?? fallbackMessage)
  restored.name = error?.name ?? 'Error'
  if (error?.stack !== undefined) {
    restored.stack = error.stack
  }
  return restored
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof RunCancelledError || err instanceof WaitTimeoutError) {
    return false
  }
  if (err instanceof Error) {
    return err.name !== RunCancelledError.name && err.name !== WaitTimeoutError.name
  }
  return true
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new RunCancelledError()
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new RunCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer.unref?.()
  })
}
