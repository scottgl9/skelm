// Public types for skelm pipelines, steps, contexts, and runs.
//
// The vocabulary here matches the planning docs:
//   - Pipeline = the unit of work (= workflow in user-facing prose).
//   - Step    = one entry in a pipeline's `steps` array.
//   - Context = the typed state flowing through the run.
//   - Run     = one execution of a pipeline.

// Identifier + payload primitives are kept in a leaf module so other
// runtime files (run-store, events, errors) can depend on them without
// pulling in this file's richer shapes — those inline-import back into
// run-store/permissions/backend and would close import cycles.
export type {
  RunId,
  StepId,
  RunStatus,
  StepStatus,
  StepKind,
  SerializedError,
} from './types-base.js'
import type {
  RunId,
  RunStatus,
  SerializedError,
  StepId,
  StepKind,
  StepStatus,
} from './types-base.js'

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
  | {
      readonly mode: 'git-repo'
      /**
       * Repo spec. Accepts `owner/name` (resolved to `https://github.com/owner/name.git`)
       * or a full git URL (`https://`, `ssh://`, `git@host:owner/name`).
       */
      readonly repo: string
      /** Branch, tag, or commit SHA to check out. */
      readonly ref: string
      /**
       * Optional base ref to also fetch. Useful for PR review pipelines that
       * need both the head and the base commits to compute `git diff base..head`.
       */
      readonly baseRef?: string
      /**
       * Cache directory for the clone. Defaults to
       * `~/.skelm/repos/<owner>__<name>`. Repeated runs against the same repo
       * reuse the clone and fall back to `git fetch` instead of cloning again.
       */
      readonly cacheDir?: string
      /**
       * Optional credential pulled from the process environment and passed
       * to `git` via `http.extraheader` so it never persists in `git remote -v`.
       * Example: `{ env: 'GITHUB_TOKEN' }` injects
       * `AUTHORIZATION: bearer <token>` for each git invocation.
       */
      readonly auth?: { readonly env: string }
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
  /**
   * Per-run accessor for tracking threaded conversation state (PR/issue
   * threads, Slack threads, …). Use over hand-rolled `last-comment-seen:*`
   * keys in `ctx.state` — entries written through `threads` live in a
   * dedicated namespace (`thread:<kind>:<key>`) so they don't collide with
   * regular pipeline state.
   *
   *   const t = ctx.threads.get({ kind: 'github-pr', key: 'octo/demo#42' })
   *   await t.markSeen(commentId)
   *   for await (const c of t.unseenSince(await t.lastSeen())) { ... }
   */
  readonly threads: import('./threads.js').ThreadHost
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
  /**
   * Spawn an external executable. Available inside `code()` steps when the
   * step's `permissions.allowedExecutables` includes the resolved binary name
   * (basename of the resolved path: e.g. `git`, `python3`, `bash`). Omitted
   * for steps that have no exec capability wired (e.g. inside a `forEach`
   * iteration context derived from a non-code step).
   */
  readonly exec?: ExecFn
  /**
   * Persist binary artifacts (screenshots, evidence, etc.) on the run store.
   * Each put automatically attaches the current `runId` and `stepId`. Calls
   * publish a `tool.result` event for audit. Available when the runner was
   * given an `artifacts`-capable store (the default `MemoryRunStore` /
   * `SqliteRunStore`).
   */
  readonly artifacts?: import('./artifact-types.js').ArtifactStoreHandle
}

/** Execution request accepted by `ctx.exec`. */
export interface ExecRequest {
  /** Bare name or absolute path. Mutually exclusive with `python` / `bash`. */
  readonly command?: string
  /** Convenience: run `python3 <script> [...args]`. */
  readonly python?: string
  /** Convenience: run `bash <script> [...args]`. */
  readonly bash?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: string | Uint8Array
  readonly timeoutMs?: number
  /** When true, non-zero exit codes throw instead of returning the result. */
  readonly throwOnNonZero?: boolean
  /** Cap on captured stdout bytes; default 10 MiB. */
  readonly maxStdoutBytes?: number
  /** Cap on captured stderr bytes; default 10 MiB. */
  readonly maxStderrBytes?: number
}

/** Result of a completed `ctx.exec` call. */
export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly signal: NodeJS.Signals | null
  readonly durationMs: number
  readonly timedOut: boolean
}

export type ExecFn = (req: ExecRequest) => Promise<ExecResult>

/**
 * Predicate evaluated by the runtime before a step runs. When it returns
 * false the step is skipped: no handler is invoked, the step result is
 * recorded with `status: 'skipped'` and `output: undefined` (for top-level
 * steps), and a `step.skipped` event is published. Reading
 * `ctx.get(skippedStepId)` from a later step yields `undefined`.
 *
 * The predicate is evaluated at every dispatch site — top-level pipeline
 * steps *and* steps nested inside `parallel()` / `forEach()` / `branch()` /
 * `loop()` / `idempotent()` / `pipelineStep()`. Nested skips do not produce
 * a `StepResult` (since nested steps never produce one), but they do emit a
 * `step.skipped` event for observability.
 */
export type WhenPredicate = (ctx: Context) => boolean | Promise<boolean>

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

/** A `code()` step: arbitrary deterministic TypeScript. */
export interface CodeStep<TOutput = unknown> {
  readonly kind: 'code'
  readonly id: StepId
  /**
   * Inline run function. Mutually exclusive with `module`: exactly one must
   * be supplied to `code()`. When `module` is set, the runner loads the file
   * once on first execution and uses its exported function as `run`.
   */
  readonly run?: (ctx: Context) => TOutput | Promise<TOutput>
  /**
   * Path to an external `.ts`/`.js` module exporting the step's run function.
   * Resolved relative to the owning pipeline's `baseDir` (or `process.cwd()`
   * if absent). Absolute paths and `file://` URLs are accepted as-is.
   */
  readonly module?: string
  /** Name of the export to use from `module`. Defaults to `'default'`. */
  readonly export?: string
  readonly secrets?: readonly string[]
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
  /**
   * Permission policy for this step. `allowedExecutables` is enforced via
   * `ctx.exec`, and `allowedSecrets` gates each declared `secrets` name via
   * `ctx.secrets`; other dimensions are accepted for forward compatibility.
   * Default-deny: omitting this field denies every `ctx.exec` call, and once
   * the field is present an omitted `allowedSecrets` denies every declared
   * secret.
   */
  readonly permissions?: import('./permissions.js').AgentPermissions
  /** Aborts ctx.signal and rejects with StepTimeoutError after this many ms. */
  readonly timeoutMs?: number
  /**
   * Optional workspace for this step. When present, the runner provisions a
   * workspace before the step runs and exposes it as `ctx.workspace`. Lifecycle
   * (cleanup) follows `WorkspaceConfig.cleanup` semantics — identical to the
   * `agent()` step's workspace handling.
   */
  readonly workspace?: WorkspaceConfig | ((ctx: Context) => WorkspaceConfig)
  readonly when?: WhenPredicate
  /**
   * When true, a thrown failure in this step is recorded as a failed
   * StepResult but does not abort the pipeline — the runner continues to the
   * next step. The run's status still ends as `'failed'` and `runError` is
   * populated. `RunCancelledError` always aborts regardless of this flag.
   * Default: false. Used by test-authoring primitives (see `check()`).
   */
  readonly continueOnError?: boolean
}

/** An `infer()` step: single-shot inference against a backend. */
export interface InferStep<TOutput = unknown> {
  readonly kind: 'infer'
  readonly id: StepId
  readonly backend?: string | readonly string[]
  readonly model?: string
  readonly system?: string | ((ctx: Context) => string | Promise<string>)
  readonly prompt:
    | string
    | readonly import('./backend.js').ContentPart[]
    | ((
        ctx: Context,
      ) =>
        | string
        | readonly import('./backend.js').ContentPart[]
        | Promise<string | readonly import('./backend.js').ContentPart[]>)
  readonly outputSchema?: import('./schema.js').SkelmSchema<TOutput>
  readonly temperature?: number
  readonly maxTokens?: number
  readonly secrets?: readonly string[]
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
  readonly when?: WhenPredicate
  /**
   * When true, a thrown failure in this step is recorded as a failed
   * StepResult but does not abort the pipeline — the runner continues to the
   * next step. The run's status still ends as `'failed'` and `runError` is
   * populated. `RunCancelledError` always aborts regardless of this flag.
   * Default: false. Used by test-authoring primitives (see `check()`).
   */
  readonly continueOnError?: boolean
}

/** An `agent()` step: full agentic loop against a backend.run(). */
export interface AgentStep<TOutput = unknown> {
  readonly kind: 'agent'
  readonly id: StepId
  readonly backend?: string | readonly string[]
  readonly agentDef?: string
  readonly prompt:
    | string
    | readonly import('./backend.js').ContentPart[]
    | ((
        ctx: Context,
      ) =>
        | string
        | readonly import('./backend.js').ContentPart[]
        | Promise<string | readonly import('./backend.js').ContentPart[]>)
  readonly system?: string | ((ctx: Context) => string | Promise<string>)
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
    | readonly import('./mcp/types.js').McpServerConfig[]
    | ((ctx: Context) => readonly import('./mcp/types.js').McpServerConfig[])
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
  readonly when?: WhenPredicate
  /**
   * When true, a thrown failure in this step is recorded as a failed
   * StepResult but does not abort the pipeline — the runner continues to the
   * next step. The run's status still ends as `'failed'` and `runError` is
   * populated. `RunCancelledError` always aborts regardless of this flag.
   * Default: false. Used by test-authoring primitives (see `check()`).
   */
  readonly continueOnError?: boolean
}

export interface IdempotentStep<TOutput = unknown> {
  readonly kind: 'idempotent'
  readonly id: StepId
  readonly key: string | ((ctx: Context) => string)
  readonly step: Step
  readonly ttlMs?: number
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
  readonly when?: WhenPredicate
  /**
   * When true, a thrown failure in this step is recorded as a failed
   * StepResult but does not abort the pipeline — the runner continues to the
   * next step. The run's status still ends as `'failed'` and `runError` is
   * populated. `RunCancelledError` always aborts regardless of this flag.
   * Default: false. Used by test-authoring primitives (see `check()`).
   */
  readonly continueOnError?: boolean
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
  readonly when?: WhenPredicate
  /**
   * When true, a thrown failure in this step is recorded as a failed
   * StepResult but does not abort the pipeline — the runner continues to the
   * next step. The run's status still ends as `'failed'` and `runError` is
   * populated. `RunCancelledError` always aborts regardless of this flag.
   * Default: false. Used by test-authoring primitives (see `check()`).
   */
  readonly continueOnError?: boolean
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
  readonly when?: WhenPredicate
  /**
   * When true, a thrown failure in this step is recorded as a failed
   * StepResult but does not abort the pipeline — the runner continues to the
   * next step. The run's status still ends as `'failed'` and `runError` is
   * populated. `RunCancelledError` always aborts regardless of this flag.
   * Default: false. Used by test-authoring primitives (see `check()`).
   */
  readonly continueOnError?: boolean
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
  readonly when?: WhenPredicate
  /**
   * When true, a thrown failure in this step is recorded as a failed
   * StepResult but does not abort the pipeline — the runner continues to the
   * next step. The run's status still ends as `'failed'` and `runError` is
   * populated. `RunCancelledError` always aborts regardless of this flag.
   * Default: false. Used by test-authoring primitives (see `check()`).
   */
  readonly continueOnError?: boolean
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
  readonly when?: WhenPredicate
  /**
   * When true, a thrown failure in this step is recorded as a failed
   * StepResult but does not abort the pipeline — the runner continues to the
   * next step. The run's status still ends as `'failed'` and `runError` is
   * populated. `RunCancelledError` always aborts regardless of this flag.
   * Default: false. Used by test-authoring primitives (see `check()`).
   */
  readonly continueOnError?: boolean
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
  readonly when?: WhenPredicate
  /**
   * When true, a thrown failure in this step is recorded as a failed
   * StepResult but does not abort the pipeline — the runner continues to the
   * next step. The run's status still ends as `'failed'` and `runError` is
   * populated. `RunCancelledError` always aborts regardless of this flag.
   * Default: false. Used by test-authoring primitives (see `check()`).
   */
  readonly continueOnError?: boolean
}

/** A `pipelineStep()` step: run a nested pipeline and adopt its output. */
export interface PipelineStep<TInput = unknown, TOutput = unknown> {
  readonly kind: 'pipelineStep'
  readonly id: StepId
  readonly pipeline: Pipeline<TInput, TOutput>
  readonly input?: TInput | ((ctx: Context) => TInput)
  readonly state?: StateConfig
  readonly retry?: RetryPolicy
  readonly when?: WhenPredicate
  /**
   * When true, a thrown failure in this step is recorded as a failed
   * StepResult but does not abort the pipeline — the runner continues to the
   * next step. The run's status still ends as `'failed'` and `runError` is
   * populated. `RunCancelledError` always aborts regardless of this flag.
   * Default: false. Used by test-authoring primitives (see `check()`).
   */
  readonly continueOnError?: boolean
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
  readonly when?: WhenPredicate
  /**
   * When true, a thrown failure in this step is recorded as a failed
   * StepResult but does not abort the pipeline — the runner continues to the
   * next step. The run's status still ends as `'failed'` and `runError` is
   * populated. `RunCancelledError` always aborts regardless of this flag.
   * Default: false. Used by test-authoring primitives (see `check()`).
   */
  readonly continueOnError?: boolean
}

/** Discriminated union of all step kinds. */
export type Step =
  | CodeStep
  | InferStep
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
  | {
      kind: 'webhook'
      id?: string
      path: string
      method?: string
      secret?: string
      /**
       * Optional provider hint. When set, the gateway delegates protocol
       * specifics to the matching `@skelm/integrations` integration:
       *
       * - `'slack'`: `secret` is the signing secret. The gateway verifies
       *   `X-Slack-Signature` over the raw body using
       *   `verifySlackSignature`, rejects timestamps older than 5 minutes,
       *   and short-circuits the `url_verification` challenge.
       * - `'ms-graph'`: GET requests carrying `?validationToken=…` are
       *   answered in plain text without firing the pipeline. POST
       *   notifications are rejected with 401 unless every entry under
       *   `value[].clientState` equals the `clientState` declared here.
       *   Graph does not sign payloads, so `clientState` is the only
       *   per-subscription secret — supplying it is mandatory for
       *   production deployments.
       */
      provider?: 'slack' | 'ms-graph'
      /**
       * For `provider: 'ms-graph'`: the shared `clientState` value the Graph
       * subscription was created with. The gateway rejects POSTs whose
       * embedded `clientState` doesn't match (see `verifyMsGraphClientState`).
       */
      clientState?: string
      /**
       * Optional pre-dispatch deduplication. The gateway reads the named
       * request header on each delivery and skips dispatch when the same
       * value has been seen within `ttlMs` (default 24 hours, i.e. matches
       * GitHub's `X-GitHub-Delivery` retry window). A `webhook.deduped`
       * audit event is emitted on a hit; the HTTP response is still 200.
       */
      dedupe?: { header: string; ttlMs?: number }
    }
  | {
      /**
       * Subscribe to an external event source. The gateway owns the
       * connection lifecycle (open, reconnect with exponential backoff,
       * close on unregister) and fires the pipeline with the normalized
       * payload below. Provider-specific sockets — Slack socket mode,
       * Discord gateway — live in `@skelm/integrations`, not here.
       */
      kind: 'event-source'
      id?: string
      /**
       * Generic protocol used by the source:
       *  - `websocket`: open a WebSocket; fire on each message
       *  - `sse`: open an SSE stream; fire on each event
       *  - `rss`: poll a feed; fire once per new item (deduped by guid)
       *  - `custom`: the caller supplies a `start(fire, signal)` hook
       */
      source: 'websocket' | 'sse' | 'rss' | 'custom'
      options: {
        /** websocket / sse: URL to connect to */
        url?: string
        /** rss: feed URL to poll */
        feedUrl?: string
        /** rss: poll interval in ms (default 300_000 = 5 min) */
        pollIntervalMs?: number
        /** websocket / sse: auto-reconnect on disconnect (default true) */
        reconnect?: boolean
        /** websocket / sse: reconnect delay in ms (default 5_000) */
        reconnectDelayMs?: number
        /** websocket / sse: max reconnect attempts (default Infinity) */
        maxReconnectAttempts?: number
        /** rss: max items to fire on the first poll (default 0 = skip existing) */
        initialItems?: number
        /** custom: start/stop hook — only valid when source='custom' */
        start?: (fire: (payload: unknown) => void, signal: AbortSignal) => void | Promise<void>
      }
      /** Optional payload filter; equality on each key. */
      filter?: Record<string, unknown>
    }
  | {
      kind: 'cron'
      id?: string
      /** Cron expression. `expression` is accepted as an alias (the POST
       *  /schedules field name); supply exactly one. Both empty/omitted ⇒ the
       *  trigger is skipped at discovery rather than crashing the parser. */
      cron?: string
      /** Alias for `cron` (matches the POST /schedules API shape). */
      expression?: string
      tz?: string
    }
  | { kind: 'interval'; id?: string; everyMs?: number; every?: string }
  | {
      /**
       * Watch a filesystem path and fire the pipeline on file events. The
       * gateway runs `fs.watch` with `recursive: true`; rename events are
       * mapped to `create`/`delete` based on whether the path exists after.
       */
      kind: 'file-watch'
      id?: string
      /** Path to watch (file or directory). */
      path: string
      /** Events to fire on. Default: all three. */
      events?: readonly ('create' | 'update' | 'delete')[]
      /** Coalesce rapid events into one fire (default 100 ms). */
      debounceMs?: number
    }
  | {
      /**
       * GitHub PR-aware trigger. The gateway wires this to a `webhook` trigger
       * with dedupe on `X-GitHub-Delivery` (item 4) and delivers a normalized
       * `{ pr, kind, raw, authorIsBot }` payload to the pipeline. Use
       * `registerGitHubPrTrigger()` from `@skelm/integrations` to bind a
       * declared trigger to a running gateway at startup.
       */
      kind: 'github-pr'
      id?: string
      /** Webhook receive path, e.g. `/hooks/github/prs`. */
      path: string
      /** HMAC shared secret for `x-hub-signature-256` (verified by the helper). */
      secret?: string
      /** GitHub event kinds to forward. Default: every kind. */
      events?: readonly (
        | 'opened'
        | 'synchronize'
        | 'reopened'
        | 'closed'
        | 'review_requested'
        | 'commented'
        | 'submitted'
      )[]
      /** Filters applied to the normalized payload before firing the pipeline. */
      filter?: {
        readonly dropBotAuthors?: boolean
        readonly repos?: readonly string[]
      }
    }

/** A pipeline value produced by `pipeline()`. */
export interface Pipeline<TInput = unknown, TOutput = unknown> {
  readonly id: string
  readonly description?: string
  readonly version?: string
  readonly steps: readonly Step[]
  /**
   * Absolute directory used to resolve relative paths declared on steps
   * (e.g. `code({ module: './step.ts' })`). Populated by the CLI workflow
   * loader from the pipeline file's location; left undefined when a pipeline
   * is constructed programmatically, in which case relative paths resolve
   * against `process.cwd()`.
   */
  readonly baseDir?: string
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

/**
 * Serializable snapshot of an in-flight wait() request. Persisted on the
 * Run record while a step is parked so HTTP clients (the CLI's `run` poll
 * loop, dashboards) can detect the pause condition from a single
 * GET /runs/:id without also fetching the event log.
 *
 * Mirrors the subset of WaitRequest that survives JSON round-trip — i.e.
 * everything except `signal` and `outputSchema`.
 */
export interface RunWaiting {
  readonly stepId: StepId
  readonly message?: string
  readonly timeoutMs?: number
  /** Wall-clock ms at which the wait() step began parking. */
  readonly since: number
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
  /**
   * Id of the trigger that produced this run, when the run was started by a
   * cron / webhook / queue / interval / manual trigger via the gateway.
   * Absent for runs started directly via `runPipeline()` or HTTP `/runs`.
   * Used by `/runs?triggerId=…` filters and dashboard groupings.
   */
  readonly triggerId?: string
  readonly status: RunStatus
  readonly input: TInput
  readonly steps: readonly StepResult[]
  readonly output: TOutput | undefined
  readonly error: SerializedError | undefined
  readonly startedAt: number
  readonly completedAt: number | undefined
  /**
   * Populated while the run is parked at a wait() step; cleared on resume.
   * Absent for runs that never reach a wait() step.
   */
  readonly waiting?: RunWaiting
}
