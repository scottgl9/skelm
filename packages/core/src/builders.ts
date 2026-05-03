import type { SkelmSchema } from './schema.js'
import type { CodeStep, Context, LlmStep, Pipeline, Step, StepId } from './types.js'

/**
 * Author a pipeline. The result is a plain immutable value carrying its
 * step list, optional finalizer, optional input/output schemas, and
 * metadata. The runtime walks `steps` in order; `finalize` (if present)
 * shapes the run output from accumulated step outputs.
 */
export function pipeline<TInput, TOutput>(def: {
  id: string
  description?: string
  version?: string
  input?: SkelmSchema<TInput>
  output?: SkelmSchema<TOutput>
  steps: readonly Step[]
  finalize?: (ctx: Context<TInput>) => TOutput | Promise<TOutput>
}): Pipeline<TInput, TOutput> {
  if (!def.id) {
    throw new Error('pipeline(): id is required')
  }
  if (!def.steps || def.steps.length === 0) {
    throw new Error(`pipeline(${def.id}): steps must contain at least one step`)
  }
  assertUniqueStepIds(def.id, def.steps)

  const out: Pipeline<TInput, TOutput> = {
    id: def.id,
    steps: Object.freeze([...def.steps]),
    ...(def.description !== undefined && { description: def.description }),
    ...(def.version !== undefined && { version: def.version }),
    ...(def.input !== undefined && { inputSchema: def.input }),
    ...(def.output !== undefined && { outputSchema: def.output }),
    ...(def.finalize !== undefined && { finalize: def.finalize }),
  }
  return Object.freeze(out)
}

/**
 * Author a deterministic code step. `run` receives the typed context and
 * returns the step's output; the output is recorded under `ctx.steps[id]`
 * for later steps to read.
 */
export function code<TOutput>(def: {
  id: StepId
  run: (ctx: Context) => TOutput | Promise<TOutput>
}): CodeStep<TOutput> {
  if (!def.id) {
    throw new Error('code(): id is required')
  }
  if (typeof def.run !== 'function') {
    throw new Error(`code(${def.id}): run must be a function`)
  }
  return Object.freeze({
    kind: 'code',
    id: def.id,
    run: def.run,
  })
}

/**
 * Author a single-shot LLM inference step. The backend resolves at run
 * time (step-level `backend` overrides the registry's default). When
 * `output` is supplied, the runtime requests structured output from the
 * backend and validates the result against the schema before recording it.
 */
export function llm<TOutput>(def: {
  id: StepId
  backend?: string
  model?: string
  system?: string | ((ctx: Context) => string)
  prompt: string | ((ctx: Context) => string)
  output?: SkelmSchema<TOutput>
  temperature?: number
  maxTokens?: number
}): LlmStep<TOutput> {
  if (!def.id) {
    throw new Error('llm(): id is required')
  }
  if (def.prompt === undefined) {
    throw new Error(`llm(${def.id}): prompt is required`)
  }
  return Object.freeze({
    kind: 'llm',
    id: def.id,
    prompt: def.prompt,
    ...(def.backend !== undefined && { backend: def.backend }),
    ...(def.model !== undefined && { model: def.model }),
    ...(def.system !== undefined && { system: def.system }),
    ...(def.output !== undefined && { outputSchema: def.output }),
    ...(def.temperature !== undefined && { temperature: def.temperature }),
    ...(def.maxTokens !== undefined && { maxTokens: def.maxTokens }),
  })
}

function assertUniqueStepIds(pipelineId: string, steps: readonly Step[]): void {
  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new Error(`pipeline(${pipelineId}): duplicate step id "${step.id}"`)
    }
    seen.add(step.id)
  }
}
