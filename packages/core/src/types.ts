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
  | 'idempotent'
  | 'parallel'
  | 'forEach'
  | 'branch'
  | 'loop'
  | 'wait'
  | 'pipelineStep'
  | 'invoke'

/** Metadata about the current run, available on `ctx.run`. */
export interface RunMetadata {
  readonly runId: RunId
  readonly pipelineId: string
  readonly startedAt: number
}

export type WorkspaceConfig =
  | {
      readonly mode: 'persistent'
      readonly name: string
      readonly base?: string
      readonly gitRoot?: boolean
      readonly cleanup?: 'never' | 'on-success'
      /** Seed files copied into the workspace before the step runs. */
      readonly seed?: { readonly copy: readonly string[] }
    }
  | {
      readonly mode: 'ephemeral'
      readonly prefix?: string
      readonly cleanup?: 'on-step-end' | 'on-run-end' | 'on-success'
      /**
       * Optional seed: copy files/directories into the workspace before
       * the step runs. Paths are resolved relative to `process.cwd()`.
       * Example: `seed: { copy: ['./src/', './package.json'] }`
       */
      readonly seed?: { readonly copy: readonly string[] }
    }
  | {
      readonly mode: 'mounted'
      readonly path: string
      /** Seed files copied into the workspace before the step runs. */
      readonly seed?: { readonly copy: readonly string[] }
    }

export interface WorkspaceHandle {
  readonly path: string
  readonly mode: WorkspaceConfig['mode']
  readonly name?: string
}

export type StateScope = 'pipeline' | 'step' | 'pipeline+name'

export interface StateConfig {
  readonly scope?: StateScope
  readonly name?: string
}

export interface StateSetOptions {
  readonly ttlMs?: number
}

export interface StateReadOptions {
  readonly since?: number
  readonly limit?: number
}

export interface StateEntry {
  readonly key: string
  readonly value: unknown
}

export interface State {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T, opts?: StateSetOptions): Promise<void>
  delete(key: string): Promise<void>
  list(prefix?: string): AsyncIterable<StateEntry>
  cas<T>(key: string, expected: T | undefined, next: T): Promise<boolean>
  append(stream: string, entry: unknown): Promise<void>
  read(stream: string, opts?: StateReadOptions): AsyncIterable<unknown>
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
  readonly state: State
  readonly workspace?: WorkspaceHandle
  /**
   * Current item when inside a `forEach` step. Undefined outside forEach.
   * Typed as `unknown`; cast to your item type in the step's `run` function.
   */
  readonly item?: unknown
  /**
   * Resolved secrets for this step, keyed by name.
   * Only populated when the step declares `secrets: [...]` and the runner
   * has a SecretResolver configured. Absent keys resolve to undefined.
   *
   * Use in code() steps:
   *   const token = ctx.secrets?.get('GITHUB_TOKEN')
   */
  readonly secrets?: {
    get(name: string): string | undefined
  }
  /**
   * Typed accessor for prior step outputs. Equivalent to
   * `ctx.steps[stepId] as T | undefined`, but self-documents the assertion
   * at the call site:
   *
   *   const fetched = ctx.get<{ data: string[] }>('fetch')
   *
   * Use this in preference to `ctx.steps[id] as T` so reviewers can see the
   * type assertion is intentional. Returns `undefined` when the step has
   * not produced output yet (e.g. inside an idempotent cache lookup, or
   * for an id that does not exist).
   */
  get<T = unknown>(stepId: StepId): T | undefined
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
  readonly secrets?: readonly string[]
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
}

/** An `llm()` step: single-shot inference against a backend. */
export interface LlmStep<TOutput = unknown> {
  readonly kind: 'llm'
  readonly id: StepId
  readonly backend?: string | readonly string[]
  readonly model?: string
  readonly system?: string | ((ctx: Context) => string)
  readonly prompt: string | ((ctx: Context) => string)
  readonly outputSchema?: import('./schema.js').SkelmSchema<TOutput>
  readonly temperature?: number
  readonly maxTokens?: number
  readonly secrets?: readonly string[]
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
}

/** An `agent()` step: full agentic loop against a backend.run(). */
export interface AgentStep<TOutput = unknown> {
  readonly kind: 'agent'
  readonly id: StepId
  readonly backend?: string | readonly string[]
  readonly agentDef?: string
  readonly prompt: string | ((ctx: Context) => string)
  readonly system?: string | ((ctx: Context) => string)
  /**
   * How `system` (and any AGENTS.md/SOUL.md) should compose with the backend's
   * built-in default system prompt.
   *   - `'extend'` (default): prepend the built-in default, then SOUL.md /
   *     AGENTS.md / `system` last so user content carries recency weight.
   *   - `'replace'`: drop the built-in default and use only the user-supplied
   *     content. Backend will still inject AGENTS.md/SOUL.md unless
   *     `systemPromptIncludeAgentDef: false`.
   */
  readonly systemPromptMode?: 'extend' | 'replace'
  /**
   * Only meaningful with `systemPromptMode: 'replace'`. Default true — keeps
   * the agent's AGENTS.md / SOUL.md even when the rest of the built-in default
   * is dropped. Set false to send the user's `system` verbatim with no other
   * skelm-authored content.
   */
  readonly systemPromptIncludeAgentDef?: boolean
  readonly mcp?:
    | readonly import('./backend.js').McpServerConfig[]
    | ((ctx: Context) => readonly import('./backend.js').McpServerConfig[])
  readonly skills?: readonly string[]
  /**
   * Secret names this step declares it needs. Resolved through the runner's
   * SecretResolver and passed to the backend via AgentRequest.secrets, so the
   * backend can inject them as env vars on tool/exec calls. Names not in the
   * step's `permissions.allowedSecrets` are denied with a `permission.denied`
   * event (dimension: 'secret').
   */
  readonly secrets?: readonly string[]
  readonly workspace?: WorkspaceConfig | ((ctx: Context) => WorkspaceConfig)
  readonly outputSchema?: import('./schema.js').SkelmSchema<TOutput>
  readonly permissions?: import('./permissions.js').AgentPermissions
  readonly maxTurns?: number
  /**
   * Wall-clock timeout in milliseconds. When set, the runner aborts the
   * backend's run() call (via the BackendContext signal) and throws
   * StepTimeoutError if the step has not produced a result by then.
   * Cooperates with the step's retry policy: a timeout counts as a retryable
   * failure.
   */
  readonly timeoutMs?: number
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
}

export interface IdempotentStep<TOutput = unknown> {
  readonly kind: 'idempotent'
  readonly id: StepId
  readonly key: string | ((ctx: Context) => string)
  readonly step: Step
  readonly ttlMs?: number
  readonly state?: StateConfig
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
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
}

/** A `forEach()` step: maps a step factory over a collection. */
export interface ForEachStep {
  readonly kind: 'forEach'
  readonly id: StepId
  readonly items: (ctx: Context) => readonly unknown[]
  readonly concurrency?: number
  readonly step: (item: unknown, index: number) => Step
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
}

/** A `branch()` step: discriminator-driven case selection. */
export interface BranchStep {
  readonly kind: 'branch'
  readonly id: StepId
  readonly on: (ctx: Context) => string
  readonly cases: Readonly<Record<string, Step>>
  readonly default?: Step
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
}

/** A `loop()` step: bounded iteration while a predicate holds. */
export interface LoopStep {
  readonly kind: 'loop'
  readonly id: StepId
  readonly while: (ctx: Context) => boolean | Promise<boolean>
  readonly maxIterations: number
  readonly step: Step
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
}

/** A `wait()` step: pause until a caller resumes the run with input. */
export interface WaitStep<TOutput = unknown> {
  readonly kind: 'wait'
  readonly id: StepId
  readonly message?: string | ((ctx: Context) => string)
  readonly timeoutMs?: number
  readonly outputSchema?: import('./schema.js').SkelmSchema<TOutput>
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
}

/** A `pipelineStep()` step: run a nested pipeline and adopt its output. */
export interface PipelineStep<TInput = unknown, TOutput = unknown> {
  readonly kind: 'pipelineStep'
  readonly id: StepId
  readonly pipeline: Pipeline<TInput, TOutput>
  readonly input?: TInput | ((ctx: Context) => TInput)
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
}

/** An `invoke()` step: run a pipeline looked up by ID from the workflow registry at runtime. */
export interface InvokeStep<TInput = unknown, TOutput = unknown> {
  readonly kind: 'invoke'
  readonly id: StepId
  /** The ID of the pipeline to invoke (as registered in the gateway's workflow registry). */
  readonly pipelineId: string
  /** Input to pass to the invoked pipeline. Defaults to the current pipeline's input. */
  readonly input?: TInput | ((ctx: Context) => TInput)
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
}

/** Discriminated union of all step kinds. */
export type Step =
  | CodeStep
  | LlmStep
  | AgentStep
  | IdempotentStep
  | ParallelStep
  | ForEachStep
  | BranchStep
  | LoopStep
  | WaitStep
  | PipelineStep
  | InvokeStep

/**
 * Trigger declared on a pipeline. The gateway reads these at startup and
 * registers them with the trigger coordinator, filling in `workflowId` from
 * the workflow's registry id. This is a customer-facing subset of the
 * gateway's full TriggerSpec — the pipeline file declares the *intent*; the
 * gateway resolves source ids against config.triggerSources to bind a
 * concrete driver.
 */
export type PipelineTrigger =
  | { kind: 'queue'; id?: string; sourceId: string; config?: Record<string, unknown> }
  | { kind: 'webhook'; id?: string; path: string; method?: string; secret?: string }
  | { kind: 'cron'; id?: string; cron: string }
  | { kind: 'interval'; id?: string; everyMs: number }

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
  /**
   * Optional triggers that bind this pipeline to external event sources.
   * The gateway auto-registers these on startup. Pipelines run via
   * `runPipeline()` or `skelm run` ignore this field.
   */
  readonly triggers?: readonly PipelineTrigger[]
  /** Phantom marker for the pipeline's input type; carried for inference. */
  readonly _input?: TInput
  /** Phantom marker for the pipeline's output type. */
  readonly _output?: TOutput
}

/** Final record of a completed (or failed / cancelled) run. */
export interface Run<TInput = unknown, TOutput = unknown> {
  readonly runId: RunId
  readonly pipelineId: string
  /**
   * Absolute path to the workflow file that produced this run, when known.
   * Populated by the gateway dispatcher from the workflow registry; absent
   * for runs started directly via `runPipeline()` or the CLI.
   */
  readonly workflowPath?: string
  readonly status: RunStatus
  readonly input: TInput
  readonly steps: readonly StepResult[]
  readonly output: TOutput | undefined
  readonly error: SerializedError | undefined
  readonly startedAt: number
  readonly completedAt: number | undefined
}
