import { RunCancelledError, serializeError } from './errors.js'
import { EventBus } from './events.js'
import { SchemaValidationError, validate } from './schema.js'
import type { Context, Pipeline, Run, RunMetadata, Step, StepId, StepResult } from './types.js'

export interface RunOptions {
  /** Optional run id; generated if omitted. */
  runId?: string
  /** Optional abort signal to cancel the run from outside. */
  signal?: AbortSignal
  /** Optional event bus to publish run events to; one is created if omitted. */
  events?: EventBus
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
      const output = await runStep(step, ctx)
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

async function runStep(step: Step, ctx: Context): Promise<unknown> {
  switch (step.kind) {
    case 'code':
      return await step.run(ctx)
    default: {
      const exhaustive: never = step.kind
      throw new Error(`unknown step kind: ${exhaustive as string}`)
    }
  }
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
