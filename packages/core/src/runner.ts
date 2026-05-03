import {
  type AgentRequest,
  BackendCapabilityError,
  BackendNotFoundError,
  type BackendRegistry,
} from './backend.js'
import { RunCancelledError, WaitTimeoutError, serializeError } from './errors.js'
import { EventBus } from './events.js'
import { createMcpHost } from './mcp/host.js'
import { TrustEnforcer, resolvePermissions } from './permissions.js'
import type { RunStore } from './run-store.js'
import { SchemaValidationError, validate } from './schema.js'
import type { Context, Pipeline, Run, RunMetadata, Step, StepId, StepResult } from './types.js'

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
  /** Optional hook used by wait() steps to suspend until external input arrives. */
  waitForInput?: (request: WaitRequest) => Promise<unknown>
}

export interface WaitRequest {
  readonly runId: string
  readonly pipelineId: string
  readonly stepId: StepId
  readonly signal: AbortSignal
  readonly message?: string
  readonly timeoutMs?: number
}

export interface RunHandle<TInput = unknown, TOutput = unknown> {
  readonly runId: string
  wait(): Promise<Run<TInput, TOutput>>
}

export class Runner {
  readonly events: EventBus
  private readonly pendingWaits = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }
  >()

  constructor(
    private readonly options: Pick<RunOptions, 'backends' | 'store'> & { events?: EventBus } = {},
  ) {
    this.events = options.events ?? new EventBus()
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
    this.events.publish({
      type: 'run.waiting',
      runId: request.runId,
      stepId: request.stepId,
      ...(request.message !== undefined && { message: request.message }),
      ...(request.timeoutMs !== undefined && { timeoutMs: request.timeoutMs }),
      at: Date.now(),
    })
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
  const storeWrites: Promise<void>[] = []
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
      })
      const output = await runStepWithRetry(
        step,
        ctx,
        options.backends,
        options.waitForInput,
        events,
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
): Promise<unknown> {
  const maxAttempts = step.retry?.maxAttempts ?? 1
  const backoffMultiplier = step.retry?.backoffMultiplier ?? 1
  let delayMs = step.retry?.delayMs ?? 0
  let attempt = 1

  while (true) {
    try {
      return await runStep(step, ctx, backends, waitForInput)
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

async function runStep(
  step: Step,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput?: RunOptions['waitForInput'],
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
      const promptText = typeof step.prompt === 'function' ? step.prompt(ctx) : step.prompt
      const systemText =
        step.system === undefined
          ? undefined
          : typeof step.system === 'function'
            ? step.system(ctx)
            : step.system
      const mcpServers =
        step.mcp === undefined
          ? undefined
          : typeof step.mcp === 'function'
            ? step.mcp(ctx)
            : step.mcp
      const policy =
        step.permissions !== undefined || mcpServers !== undefined
          ? resolvePermissions(undefined, step.permissions)
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
      const req: AgentRequest = {
        prompt: promptText,
        ...(systemText !== undefined && { system: systemText }),
        ...(step.maxTurns !== undefined && { maxTurns: step.maxTurns }),
        ...(policy !== undefined && { permissions: policy }),
        ...(mcpServers !== undefined && { mcpServers }),
        ...(step.outputSchema !== undefined && { outputSchema: step.outputSchema }),
      }
      const mcpHost =
        mcpServers !== undefined &&
        mcpServers.length > 0 &&
        backend.capabilities.toolPermissions === 'wrapped'
          ? await createMcpHost(mcpServers)
          : undefined
      try {
        // biome-ignore lint/style/noNonNullAssertion: capability checked in resolveForAgent
        const response = await backend.run!(req, {
          signal: ctx.signal,
          ...(mcpHost !== undefined && { mcpHost }),
        })
        if (step.outputSchema !== undefined) {
          const candidate = response.structured ?? response.text
          return await validate(step.outputSchema, candidate, 'output')
        }
        return {
          text: response.text ?? '',
          ...(response.usage !== undefined && { usage: response.usage }),
          ...(response.stopReason !== undefined && { stopReason: response.stopReason }),
        }
      } finally {
        await mcpHost?.dispose()
      }
    }
    case 'parallel':
      return await runParallel(step, ctx, backends, waitForInput)
    case 'forEach':
      return await runForEach(step, ctx, backends, waitForInput)
    case 'branch':
      return await runBranch(step, ctx, backends, waitForInput)
    case 'loop':
      return await runLoop(step, ctx, backends, waitForInput)
    case 'wait':
      return await runWait(step, ctx, waitForInput)
    case 'pipelineStep':
      return await runPipelineStep(step, ctx, backends, waitForInput)
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
): Promise<Record<string, unknown>> {
  const onError = step.onError ?? 'fail'
  const settled = await Promise.allSettled(
    step.steps.map((child) => runStep(child, ctx, backends, waitForInput)),
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

async function runForEach(
  step: Extract<Step, { kind: 'forEach' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
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
      results[i] = await runStep(child, ctx, backends, waitForInput)
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
): Promise<unknown> {
  const key = step.on(ctx)
  const chosen = step.cases[key] ?? step.default
  if (chosen === undefined) {
    throw new Error(`branch(${step.id}): no case matched "${key}" and no default was provided`)
  }
  return await runStep(chosen, ctx, backends, waitForInput)
}

async function runLoop(
  step: Extract<Step, { kind: 'loop' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
): Promise<{ iterations: unknown[]; last: unknown }> {
  const iterations: unknown[] = []
  let last: unknown
  for (let i = 0; i < step.maxIterations; i++) {
    if (!(await step.while(ctx))) break
    last = await runStep(step.step, ctx, backends, waitForInput)
    iterations.push(last)
  }
  return { iterations, last }
}

async function runWait(
  step: Extract<Step, { kind: 'wait' }>,
  ctx: Context,
  waitForInput: RunOptions['waitForInput'],
): Promise<unknown> {
  if (!waitForInput) {
    throw new Error(
      `wait(${step.id}): no wait handler configured; use Runner.start() or pass waitForInput to runPipeline()`,
    )
  }
  const resumed = await waitForInput({
    runId: ctx.run.runId,
    pipelineId: ctx.run.pipelineId,
    stepId: step.id,
    signal: ctx.signal,
    ...(step.message !== undefined && {
      message: typeof step.message === 'function' ? step.message(ctx) : step.message,
    }),
    ...(step.timeoutMs !== undefined && { timeoutMs: step.timeoutMs }),
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
): Promise<unknown> {
  const nestedInput =
    step.input === undefined
      ? ctx.input
      : typeof step.input === 'function'
        ? step.input(ctx)
        : step.input
  const nestedRun = await runPipeline(step.pipeline, nestedInput, {
    signal: ctx.signal,
    ...(backends !== undefined && { backends }),
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
