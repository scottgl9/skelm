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
export type StepKind = 'code'

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
}

/** Discriminated union of all step kinds. Grows in later stages. */
export type Step = CodeStep

/** A pipeline value produced by `pipeline()`. */
export interface Pipeline<TInput = unknown, TOutput = unknown> {
  readonly id: string
  readonly description?: string
  readonly version?: string
  readonly steps: readonly Step[]
  readonly finalize?: (ctx: Context<TInput>) => TOutput | Promise<TOutput>
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
