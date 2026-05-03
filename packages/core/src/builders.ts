import type { AgentPermissions } from './permissions.js'
import type { SkelmSchema } from './schema.js'
import type {
  AgentStep,
  BranchStep,
  CodeStep,
  Context,
  ForEachStep,
  LlmStep,
  LoopStep,
  ParallelOnError,
  ParallelStep,
  ParallelWaitFor,
  Pipeline,
  PipelineStep,
  Step,
  StepId,
} from './types.js'

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

/**
 * Author a multi-turn agent step. The backend's `run()` drives the agent
 * loop; `permissions` enforce default-deny over tools, executables, MCP
 * servers, skills, network, and filesystem access. When `output` is
 * supplied the runtime validates the agent's final result against it.
 */
export function agent<TOutput>(def: {
  id: StepId
  backend?: string
  prompt: string | ((ctx: Context) => string)
  system?: string | ((ctx: Context) => string)
  output?: SkelmSchema<TOutput>
  permissions?: AgentPermissions
  maxTurns?: number
}): AgentStep<TOutput> {
  if (!def.id) {
    throw new Error('agent(): id is required')
  }
  if (def.prompt === undefined) {
    throw new Error(`agent(${def.id}): prompt is required`)
  }
  return Object.freeze({
    kind: 'agent',
    id: def.id,
    prompt: def.prompt,
    ...(def.backend !== undefined && { backend: def.backend }),
    ...(def.system !== undefined && { system: def.system }),
    ...(def.output !== undefined && { outputSchema: def.output }),
    ...(def.permissions !== undefined && { permissions: def.permissions }),
    ...(def.maxTurns !== undefined && { maxTurns: def.maxTurns }),
  })
}

/** Run a set of named child steps concurrently. The result is keyed by child id. */
export function parallel(def: {
  id: StepId
  steps: readonly Step[]
  waitFor?: ParallelWaitFor
  onError?: ParallelOnError
}): ParallelStep {
  if (!def.id) throw new Error('parallel(): id is required')
  if (!def.steps || def.steps.length === 0) {
    throw new Error(`parallel(${def.id}): steps must contain at least one step`)
  }
  // Sibling ids must be unique within a parallel block (they become the keys
  // of the parallel output object). We do not require global uniqueness across
  // the whole pipeline tree — that is the runtime's job to track per-scope.
  const seen = new Set<string>()
  for (const s of def.steps) {
    if (seen.has(s.id)) {
      throw new Error(`parallel(${def.id}): duplicate child step id "${s.id}"`)
    }
    seen.add(s.id)
  }
  return Object.freeze({
    kind: 'parallel',
    id: def.id,
    steps: Object.freeze([...def.steps]),
    ...(def.waitFor !== undefined && { waitFor: def.waitFor }),
    ...(def.onError !== undefined && { onError: def.onError }),
  })
}

/** Map a step factory over a collection; outputs collected as an array. */
export function forEach(def: {
  id: StepId
  items: (ctx: Context) => readonly unknown[]
  concurrency?: number
  step: (item: unknown, index: number) => Step
}): ForEachStep {
  if (!def.id) throw new Error('forEach(): id is required')
  if (typeof def.items !== 'function') {
    throw new Error(`forEach(${def.id}): items must be a function`)
  }
  if (typeof def.step !== 'function') {
    throw new Error(`forEach(${def.id}): step must be a factory function`)
  }
  if (def.concurrency !== undefined && def.concurrency < 1) {
    throw new Error(`forEach(${def.id}): concurrency must be >= 1`)
  }
  return Object.freeze({
    kind: 'forEach',
    id: def.id,
    items: def.items,
    step: def.step,
    ...(def.concurrency !== undefined && { concurrency: def.concurrency }),
  })
}

/** Route to one of `cases` based on a discriminator key, with optional default. */
export function branch(def: {
  id: StepId
  on: (ctx: Context) => string
  cases: Readonly<Record<string, Step>>
  default?: Step
}): BranchStep {
  if (!def.id) throw new Error('branch(): id is required')
  if (typeof def.on !== 'function') {
    throw new Error(`branch(${def.id}): on must be a function`)
  }
  if (!def.cases || Object.keys(def.cases).length === 0) {
    throw new Error(`branch(${def.id}): cases must have at least one entry`)
  }
  return Object.freeze({
    kind: 'branch',
    id: def.id,
    on: def.on,
    cases: Object.freeze({ ...def.cases }),
    ...(def.default !== undefined && { default: def.default }),
  })
}

/** Iterate a step while a predicate holds, bounded by maxIterations. */
export function loop(def: {
  id: StepId
  while: (ctx: Context) => boolean | Promise<boolean>
  maxIterations: number
  step: Step
}): LoopStep {
  if (!def.id) throw new Error('loop(): id is required')
  if (typeof def.while !== 'function') {
    throw new Error(`loop(${def.id}): while must be a function`)
  }
  if (def.maxIterations < 1) {
    throw new Error(`loop(${def.id}): maxIterations must be >= 1`)
  }
  return Object.freeze({
    kind: 'loop',
    id: def.id,
    while: def.while,
    maxIterations: def.maxIterations,
    step: def.step,
  })
}

/** Run a nested pipeline and record its final output as this step's output. */
export function pipelineStep<TInput, TOutput>(def: {
  id: StepId
  pipeline: Pipeline<TInput, TOutput>
  input?: TInput | ((ctx: Context) => TInput)
}): PipelineStep<TInput, TOutput> {
  if (!def.id) throw new Error('pipelineStep(): id is required')
  if (!def.pipeline) {
    throw new Error(`pipelineStep(${def.id}): pipeline is required`)
  }
  return Object.freeze({
    kind: 'pipelineStep',
    id: def.id,
    pipeline: def.pipeline,
    ...(def.input !== undefined && { input: def.input }),
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
