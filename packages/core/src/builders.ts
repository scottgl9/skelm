import type { McpServerConfig } from './backend.js'
import type { AgentPermissions } from './permissions.js'
import type { SkelmSchema } from './schema.js'
import type {
  AgentStep,
  BranchStep,
  CodeStep,
  Context,
  ForEachStep,
  IdempotentStep,
  LlmStep,
  LoopStep,
  ParallelOnError,
  ParallelStep,
  ParallelWaitFor,
  Pipeline,
  PipelineStep,
  RetryPolicy,
  StateConfig,
  Step,
  StepId,
  WaitStep,
  WorkspaceConfig,
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
  state?: StateConfig
  retry?: RetryPolicy
}): CodeStep<TOutput> {
  if (!def.id) {
    throw new Error('code(): id is required')
  }
  if (typeof def.run !== 'function') {
    throw new Error(`code(${def.id}): run must be a function`)
  }
  assertValidRetryPolicy('code', def.id, def.retry)
  return Object.freeze({
    kind: 'code',
    id: def.id,
    run: def.run,
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
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
  state?: StateConfig
  retry?: RetryPolicy
}): LlmStep<TOutput> {
  if (!def.id) {
    throw new Error('llm(): id is required')
  }
  if (def.prompt === undefined) {
    throw new Error(`llm(${def.id}): prompt is required`)
  }
  assertValidRetryPolicy('llm', def.id, def.retry)
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
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
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
  agentDef?: string
  prompt: string | ((ctx: Context) => string)
  system?: string | ((ctx: Context) => string)
  mcp?: readonly McpServerConfig[] | ((ctx: Context) => readonly McpServerConfig[])
  workspace?: WorkspaceConfig | ((ctx: Context) => WorkspaceConfig)
  output?: SkelmSchema<TOutput>
  permissions?: AgentPermissions
  maxTurns?: number
  state?: StateConfig
  retry?: RetryPolicy
}): AgentStep<TOutput> {
  if (!def.id) {
    throw new Error('agent(): id is required')
  }
  if (def.prompt === undefined) {
    throw new Error(`agent(${def.id}): prompt is required`)
  }
  assertValidRetryPolicy('agent', def.id, def.retry)
  return Object.freeze({
    kind: 'agent',
    id: def.id,
    prompt: def.prompt,
    ...(def.backend !== undefined && { backend: def.backend }),
    ...(def.agentDef !== undefined && { agentDef: def.agentDef }),
    ...(def.system !== undefined && { system: def.system }),
    ...(def.mcp !== undefined && { mcp: def.mcp }),
    ...(def.workspace !== undefined && { workspace: def.workspace }),
    ...(def.output !== undefined && { outputSchema: def.output }),
    ...(def.permissions !== undefined && { permissions: def.permissions }),
    ...(def.maxTurns !== undefined && { maxTurns: def.maxTurns }),
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
  })
}

/** Run a set of named child steps concurrently. The result is keyed by child id. */
export function parallel(def: {
  id: StepId
  steps: readonly Step[]
  waitFor?: ParallelWaitFor
  onError?: ParallelOnError
  state?: StateConfig
  retry?: RetryPolicy
}): ParallelStep {
  if (!def.id) throw new Error('parallel(): id is required')
  if (!def.steps || def.steps.length === 0) {
    throw new Error(`parallel(${def.id}): steps must contain at least one step`)
  }
  assertValidRetryPolicy('parallel', def.id, def.retry)
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
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
  })
}

/** Map a step factory over a collection; outputs collected as an array. */
export function forEach(def: {
  id: StepId
  items: (ctx: Context) => readonly unknown[]
  concurrency?: number
  step: (item: unknown, index: number) => Step
  state?: StateConfig
  retry?: RetryPolicy
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
  assertValidRetryPolicy('forEach', def.id, def.retry)
  return Object.freeze({
    kind: 'forEach',
    id: def.id,
    items: def.items,
    step: def.step,
    ...(def.concurrency !== undefined && { concurrency: def.concurrency }),
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
  })
}

/** Route to one of `cases` based on a discriminator key, with optional default. */
export function branch(def: {
  id: StepId
  on: (ctx: Context) => string
  cases: Readonly<Record<string, Step>>
  default?: Step
  state?: StateConfig
  retry?: RetryPolicy
}): BranchStep {
  if (!def.id) throw new Error('branch(): id is required')
  if (typeof def.on !== 'function') {
    throw new Error(`branch(${def.id}): on must be a function`)
  }
  if (!def.cases || Object.keys(def.cases).length === 0) {
    throw new Error(`branch(${def.id}): cases must have at least one entry`)
  }
  assertValidRetryPolicy('branch', def.id, def.retry)
  return Object.freeze({
    kind: 'branch',
    id: def.id,
    on: def.on,
    cases: Object.freeze({ ...def.cases }),
    ...(def.default !== undefined && { default: def.default }),
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
  })
}

/** Iterate a step while a predicate holds, bounded by maxIterations. */
export function loop(def: {
  id: StepId
  while: (ctx: Context) => boolean | Promise<boolean>
  maxIterations: number
  step: Step
  state?: StateConfig
  retry?: RetryPolicy
}): LoopStep {
  if (!def.id) throw new Error('loop(): id is required')
  if (typeof def.while !== 'function') {
    throw new Error(`loop(${def.id}): while must be a function`)
  }
  if (def.maxIterations < 1) {
    throw new Error(`loop(${def.id}): maxIterations must be >= 1`)
  }
  assertValidRetryPolicy('loop', def.id, def.retry)
  return Object.freeze({
    kind: 'loop',
    id: def.id,
    while: def.while,
    maxIterations: def.maxIterations,
    step: def.step,
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
  })
}

/** Suspend execution until a caller resumes the run with input. */
export function wait<TOutput>(def: {
  id: StepId
  message?: string | ((ctx: Context) => string)
  timeoutMs?: number
  output?: SkelmSchema<TOutput>
  state?: StateConfig
  retry?: RetryPolicy
}): WaitStep<TOutput> {
  if (!def.id) throw new Error('wait(): id is required')
  if (def.timeoutMs !== undefined && def.timeoutMs < 1) {
    throw new Error(`wait(${def.id}): timeoutMs must be >= 1`)
  }
  assertValidRetryPolicy('wait', def.id, def.retry)
  return Object.freeze({
    kind: 'wait',
    id: def.id,
    ...(def.message !== undefined && { message: def.message }),
    ...(def.timeoutMs !== undefined && { timeoutMs: def.timeoutMs }),
    ...(def.output !== undefined && { outputSchema: def.output }),
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
  })
}

/** Run a nested pipeline and record its final output as this step's output. */
export function pipelineStep<TInput, TOutput>(def: {
  id: StepId
  pipeline: Pipeline<TInput, TOutput>
  input?: TInput | ((ctx: Context) => TInput)
  state?: StateConfig
  retry?: RetryPolicy
}): PipelineStep<TInput, TOutput> {
  if (!def.id) throw new Error('pipelineStep(): id is required')
  if (!def.pipeline) {
    throw new Error(`pipelineStep(${def.id}): pipeline is required`)
  }
  assertValidRetryPolicy('pipelineStep', def.id, def.retry)
  return Object.freeze({
    kind: 'pipelineStep',
    id: def.id,
    pipeline: def.pipeline,
    ...(def.input !== undefined && { input: def.input }),
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
  })
}

export function idempotent<TOutput>(def: {
  /**
   * Step id for the idempotent wrapper. When omitted, the inner step's id is
   * used (backward-compatible). Setting an explicit id lets callers access
   * the result as `ctx.steps[id]` independently of the inner step's id.
   */
  id?: string
  key: string | ((ctx: Context) => string)
  step: Step
  ttlMs?: number
  state?: StateConfig
  retry?: RetryPolicy
}): IdempotentStep<TOutput> {
  if (!def.step) {
    throw new Error('idempotent(): step is required')
  }
  const id = def.id ?? def.step.id
  if (!id) throw new Error('idempotent(): id is required (or provide a step with an id)')
  return Object.freeze({
    kind: 'idempotent',
    id,
    key: def.key,
    step: def.step,
    ...(def.ttlMs !== undefined && { ttlMs: def.ttlMs }),
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
  })
}

function assertValidRetryPolicy(kind: string, id: StepId, retry: RetryPolicy | undefined): void {
  if (!retry) return
  if (retry.maxAttempts < 1) {
    throw new Error(`${kind}(${id}): retry.maxAttempts must be >= 1`)
  }
  if (retry.delayMs !== undefined && retry.delayMs < 0) {
    throw new Error(`${kind}(${id}): retry.delayMs must be >= 0`)
  }
  if (retry.backoffMultiplier !== undefined && retry.backoffMultiplier < 1) {
    throw new Error(`${kind}(${id}): retry.backoffMultiplier must be >= 1`)
  }
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
