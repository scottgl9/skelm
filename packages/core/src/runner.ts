import { type AgentRequest, BackendNotFoundError, type BackendRegistry } from './backend.js'
import { RunCancelledError, serializeError } from './errors.js'
import { EventBus } from './events.js'
import { resolvePermissions } from './permissions.js'
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
      return Object.freeze({
        runId,
        pipelineId: pipeline.id,
        status: runStatus,
        input,
        steps: Object.freeze(stepResults),
        output: undefined,
        error: runError,
        startedAt,
        completedAt,
      })
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
      const output = await runStep(step, ctx, options.backends)
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

  return Object.freeze({
    runId,
    pipelineId: pipeline.id,
    status: runStatus,
    input: resolvedInput,
    steps: Object.freeze(stepResults),
    output: runStatus === 'completed' ? finalOutput : undefined,
    error: runError,
    startedAt,
    completedAt,
  })
}

export { SchemaValidationError }

async function runStep(
  step: Step,
  ctx: Context,
  backends: BackendRegistry | undefined,
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
      const policy = step.permissions ? resolvePermissions(undefined, step.permissions) : undefined
      const req: AgentRequest = {
        prompt: promptText,
        ...(systemText !== undefined && { system: systemText }),
        ...(step.maxTurns !== undefined && { maxTurns: step.maxTurns }),
        ...(policy !== undefined && { permissions: policy }),
        ...(step.outputSchema !== undefined && { outputSchema: step.outputSchema }),
      }
      // biome-ignore lint/style/noNonNullAssertion: capability checked in resolveForAgent
      const response = await backend.run!(req, { signal: ctx.signal })
      if (step.outputSchema !== undefined) {
        const candidate = response.structured ?? response.text
        return await validate(step.outputSchema, candidate, 'output')
      }
      return {
        text: response.text ?? '',
        ...(response.usage !== undefined && { usage: response.usage }),
        ...(response.stopReason !== undefined && { stopReason: response.stopReason }),
      }
    }
    case 'parallel':
      return await runParallel(step, ctx, backends)
    case 'forEach':
      return await runForEach(step, ctx, backends)
    case 'branch':
      return await runBranch(step, ctx, backends)
    case 'loop':
      return await runLoop(step, ctx, backends)
    case 'pipelineStep':
      return await runPipelineStep(step, ctx, backends)
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
): Promise<Record<string, unknown>> {
  const onError = step.onError ?? 'fail'
  const settled = await Promise.allSettled(step.steps.map((child) => runStep(child, ctx, backends)))
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
      results[i] = await runStep(child, ctx, backends)
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
): Promise<unknown> {
  const key = step.on(ctx)
  const chosen = step.cases[key] ?? step.default
  if (chosen === undefined) {
    throw new Error(`branch(${step.id}): no case matched "${key}" and no default was provided`)
  }
  return await runStep(chosen, ctx, backends)
}

async function runLoop(
  step: Extract<Step, { kind: 'loop' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
): Promise<{ iterations: unknown[]; last: unknown }> {
  const iterations: unknown[] = []
  let last: unknown
  for (let i = 0; i < step.maxIterations; i++) {
    if (!(await step.while(ctx))) break
    last = await runStep(step.step, ctx, backends)
    iterations.push(last)
  }
  return { iterations, last }
}

async function runPipelineStep(
  step: Extract<Step, { kind: 'pipelineStep' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
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
