// Public types for skelm pipelines, steps, contexts, and runs.
//
// The vocabulary here matches the planning docs:
//   - Pipeline = the unit of work (= workflow in user-facing prose).
//   - Step    = one entry in a pipeline's `steps` array.
//   - Context = the typed state flowing through the run.
//   - Run     = one execution of a pipeline.

/** Stable run identifier. UUID v4 in practice; opaque string in the type. */
export type RunId = string

/** Stable identifier for a step within a pipeline. */
export type StepId = string

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting'

export type StepStatus = 'completed' | 'failed' | 'skipped' | 'waiting'

/** Discriminator for step kinds; the union grows in later stages. */
export type StepKind =
  | 'code'
  | 'llm'
  | 'agent'
  | 'parallel'
  | 'forEach'
  | 'branch'
  | 'loop'
  | 'wait'
  | 'pipelineStep'

/** Metadata about the current run, available on `ctx.run`. */
export interface RunMetadata {
  readonly runId: RunId
  readonly pipelineId: string
  readonly startedAt: number
}

/**
 * Typed context passed to every step handler. The `steps` field accumulates
 * step outputs as the run progresses; later stages will narrow it via type
 * inference, but for now it is a record keyed by step id.
 */
export interface Context<TInput = unknown> {
  readonly input: TInput
  readonly steps: Readonly<Record<StepId, unknown>>
  readonly run: RunMetadata
  readonly signal: AbortSignal
}

/** Per-step retry policy applied by the runner around step execution. */
export interface RetryPolicy {
  readonly maxAttempts: number
  readonly delayMs?: number
  readonly backoffMultiplier?: number
}

/** Result of a single step's execution. */
export interface StepResult<TOutput = unknown> {
  readonly id: StepId
  readonly kind: StepKind
  readonly status: StepStatus
  readonly output: TOutput
  readonly startedAt: number
  readonly completedAt: number
  readonly error?: SerializedError
}

/** A serialized error suitable for storage and event payloads. */
export interface SerializedError {
  readonly name: string
  readonly message: string
  readonly stack?: string
}

/** A `code()` step: arbitrary deterministic TypeScript. */
export interface CodeStep<TOutput = unknown> {
  readonly kind: 'code'
  readonly id: StepId
  readonly run: (ctx: Context) => TOutput | Promise<TOutput>
  readonly retry?: RetryPolicy
}

/** An `llm()` step: single-shot inference against a backend. */
export interface LlmStep<TOutput = unknown> {
  readonly kind: 'llm'
  readonly id: StepId
  readonly backend?: string
  readonly model?: string
  readonly system?: string | ((ctx: Context) => string)
  readonly prompt: string | ((ctx: Context) => string)
  readonly outputSchema?: import('./schema.js').SkelmSchema<TOutput>
  readonly temperature?: number
  readonly maxTokens?: number
  readonly retry?: RetryPolicy
}

/** An `agent()` step: full agentic loop against a backend.run(). */
export interface AgentStep<TOutput = unknown> {
  readonly kind: 'agent'
  readonly id: StepId
  readonly backend?: string
  readonly agentDef?: string
  readonly prompt: string | ((ctx: Context) => string)
  readonly system?: string | ((ctx: Context) => string)
  readonly mcp?:
    | readonly import('./backend.js').McpServerConfig[]
    | ((ctx: Context) => readonly import('./backend.js').McpServerConfig[])
  readonly outputSchema?: import('./schema.js').SkelmSchema<TOutput>
  readonly permissions?: import('./permissions.js').AgentPermissions
  readonly maxTurns?: number
  readonly retry?: RetryPolicy
}

export type ParallelWaitFor = 'all' | 'any' | { atLeast: number }
export type ParallelOnError = 'fail' | 'continue' | 'partial'

/** A `parallel()` step: runs named children concurrently; output is keyed by child id. */
export interface ParallelStep {
  readonly kind: 'parallel'
  readonly id: StepId
  readonly steps: readonly Step[]
  readonly waitFor?: ParallelWaitFor
  readonly onError?: ParallelOnError
  readonly retry?: RetryPolicy
}

/** A `forEach()` step: maps a step factory over a collection. */
export interface ForEachStep {
  readonly kind: 'forEach'
  readonly id: StepId
  readonly items: (ctx: Context) => readonly unknown[]
  readonly concurrency?: number
  readonly step: (item: unknown, index: number) => Step
  readonly retry?: RetryPolicy
}

/** A `branch()` step: discriminator-driven case selection. */
export interface BranchStep {
  readonly kind: 'branch'
  readonly id: StepId
  readonly on: (ctx: Context) => string
  readonly cases: Readonly<Record<string, Step>>
  readonly default?: Step
  readonly retry?: RetryPolicy
}

/** A `loop()` step: bounded iteration while a predicate holds. */
export interface LoopStep {
  readonly kind: 'loop'
  readonly id: StepId
  readonly while: (ctx: Context) => boolean | Promise<boolean>
  readonly maxIterations: number
  readonly step: Step
  readonly retry?: RetryPolicy
}

/** A `wait()` step: pause until a caller resumes the run with input. */
export interface WaitStep<TOutput = unknown> {
  readonly kind: 'wait'
  readonly id: StepId
  readonly message?: string | ((ctx: Context) => string)
  readonly timeoutMs?: number
  readonly outputSchema?: import('./schema.js').SkelmSchema<TOutput>
  readonly retry?: RetryPolicy
}

/** A `pipelineStep()` step: run a nested pipeline and adopt its output. */
export interface PipelineStep<TInput = unknown, TOutput = unknown> {
  readonly kind: 'pipelineStep'
  readonly id: StepId
  readonly pipeline: Pipeline<TInput, TOutput>
  readonly input?: TInput | ((ctx: Context) => TInput)
  readonly retry?: RetryPolicy
}

/** Discriminated union of all step kinds. */
export type Step =
  | CodeStep
  | LlmStep
  | AgentStep
  | ParallelStep
  | ForEachStep
  | BranchStep
  | LoopStep
  | WaitStep
  | PipelineStep

/** A pipeline value produced by `pipeline()`. */
export interface Pipeline<TInput = unknown, TOutput = unknown> {
  readonly id: string
  readonly description?: string
  readonly version?: string
  readonly steps: readonly Step[]
  readonly finalize?: (ctx: Context<TInput>) => TOutput | Promise<TOutput>
  /** Optional input schema; validated at run start. */
  readonly inputSchema?: import('./schema.js').SkelmSchema<TInput>
  /** Optional output schema; validated after finalize before returning. */
  readonly outputSchema?: import('./schema.js').SkelmSchema<TOutput>
  /** Phantom marker for the pipeline's input type; carried for inference. */
  readonly _input?: TInput
  /** Phantom marker for the pipeline's output type. */
  readonly _output?: TOutput
}

/** Final record of a completed (or failed / cancelled) run. */
export interface Run<TInput = unknown, TOutput = unknown> {
  readonly runId: RunId
  readonly pipelineId: string
  readonly status: RunStatus
  readonly input: TInput
  readonly steps: readonly StepResult[]
  readonly output: TOutput | undefined
  readonly error: SerializedError | undefined
  readonly startedAt: number
  readonly completedAt: number | undefined
}
