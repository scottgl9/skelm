import type { McpServerConfig } from './backend.js'
import { parseDuration } from './duration.js'
import type { AgentPermissions } from './permissions.js'
import type { SkelmSchema } from './schema.js'
import type {
  AgentStep,
  BranchStep,
  CodeStep,
  Context,
  ForEachStep,
  IdempotentStep,
  InvokeStep,
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
  WhenPredicate,
  WorkspaceConfig,
} from './types.js'

function normalizePipelineTrigger(
  pipelineId: string,
  trigger: import('./types.js').PipelineTrigger,
): import('./types.js').PipelineTrigger {
  if (trigger.kind !== 'interval') return trigger

  const everyMs =
    typeof trigger.everyMs === 'number'
      ? trigger.everyMs
      : typeof trigger.every === 'string'
        ? parseDuration(trigger.every)
        : undefined
  if (everyMs === undefined) {
    throw new Error(
      `pipeline(${pipelineId}): interval trigger "${trigger.id ?? '(unnamed)'}" must set either everyMs or every`,
    )
  }
  return Object.freeze({ ...trigger, everyMs })
}

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
  triggers?: readonly import('./types.js').PipelineTrigger[]
  /**
   * Directory used to resolve relative paths declared on steps (e.g.
   * `code({ module: './x.ts' })`). Normally set by the CLI workflow loader;
   * authors only set this when constructing a pipeline programmatically.
   */
  baseDir?: string
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
    ...(def.triggers !== undefined && {
      triggers: Object.freeze(
        def.triggers.map((trigger) => normalizePipelineTrigger(def.id, trigger)),
      ),
    }),
    ...(def.baseDir !== undefined && { baseDir: def.baseDir }),
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
  /** Inline run function. Mutually exclusive with `module`. */
  run?: (ctx: Context) => TOutput | Promise<TOutput>
  /**
   * Path to an external `.ts` / `.js` module that exports the step's run
   * function. Resolved relative to the owning pipeline's `baseDir` (or
   * `process.cwd()` when absent).
   */
  module?: string
  /** Name of the export to use from `module`. Defaults to `'default'`. */
  export?: string
  secrets?: readonly string[]
  state?: StateConfig
  retry?: RetryPolicy
  permissions?: AgentPermissions
  timeoutMs?: number
  workspace?: WorkspaceConfig | ((ctx: Context) => WorkspaceConfig)
  when?: WhenPredicate
  continueOnError?: boolean
}): CodeStep<TOutput> {
  if (!def.id) {
    throw new Error('code(): id is required')
  }
  const hasRun = typeof def.run === 'function'
  const hasModule = typeof def.module === 'string' && def.module.length > 0
  if (hasRun === hasModule) {
    throw new Error(
      `code(${def.id}): must supply exactly one of "run" or "module" (got ${
        hasRun && hasModule ? 'both' : 'neither'
      })`,
    )
  }
  if (!hasModule && def.export !== undefined) {
    throw new Error(`code(${def.id}): "export" only applies when "module" is set`)
  }
  assertValidRetryPolicy('code', def.id, def.retry)
  return Object.freeze({
    kind: 'code',
    id: def.id,
    ...(def.run !== undefined && { run: def.run }),
    ...(def.module !== undefined && { module: def.module }),
    ...(def.export !== undefined && { export: def.export }),
    ...(def.secrets !== undefined && { secrets: def.secrets }),
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
    ...(def.permissions !== undefined && { permissions: def.permissions }),
    ...(def.timeoutMs !== undefined && { timeoutMs: def.timeoutMs }),
    ...(def.workspace !== undefined && { workspace: def.workspace }),
    ...(def.when !== undefined && { when: def.when }),
    ...(def.continueOnError !== undefined && { continueOnError: def.continueOnError }),
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
  backend?: string | readonly string[]
  model?: string
  system?: string | ((ctx: Context) => string | Promise<string>)
  prompt:
    | string
    | readonly import('./backend.js').ContentPart[]
    | ((
        ctx: Context,
      ) =>
        | string
        | readonly import('./backend.js').ContentPart[]
        | Promise<string | readonly import('./backend.js').ContentPart[]>)
  output?: SkelmSchema<TOutput>
  temperature?: number
  maxTokens?: number
  secrets?: readonly string[]
  state?: StateConfig
  retry?: RetryPolicy
  when?: WhenPredicate
  continueOnError?: boolean
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
    ...(def.secrets !== undefined && { secrets: def.secrets }),
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
    ...(def.when !== undefined && { when: def.when }),
    ...(def.continueOnError !== undefined && { continueOnError: def.continueOnError }),
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
  backend?: string | readonly string[]
  agentDef?: string
  prompt:
    | string
    | readonly import('./backend.js').ContentPart[]
    | ((
        ctx: Context,
      ) =>
        | string
        | readonly import('./backend.js').ContentPart[]
        | Promise<string | readonly import('./backend.js').ContentPart[]>)
  system?: string | ((ctx: Context) => string | Promise<string>)
  systemPromptMode?: 'extend' | 'replace'
  systemPromptIncludeAgentDef?: boolean
  mcp?: readonly McpServerConfig[] | ((ctx: Context) => readonly McpServerConfig[])
  skills?: readonly string[]
  secrets?: readonly string[]
  workspace?: WorkspaceConfig | ((ctx: Context) => WorkspaceConfig)
  output?: SkelmSchema<TOutput>
  permissions?: AgentPermissions
  maxTurns?: number
  timeoutMs?: number
  state?: StateConfig
  retry?: RetryPolicy
  when?: WhenPredicate
  continueOnError?: boolean
}): AgentStep<TOutput> {
  if (!def.id) {
    throw new Error('agent(): id is required')
  }
  if (def.prompt === undefined) {
    throw new Error(`agent(${def.id}): prompt is required`)
  }
  if (def.timeoutMs !== undefined && (!Number.isFinite(def.timeoutMs) || def.timeoutMs < 1)) {
    throw new Error(`agent(${def.id}): timeoutMs must be a positive integer`)
  }
  assertValidRetryPolicy('agent', def.id, def.retry)
  return Object.freeze({
    kind: 'agent',
    id: def.id,
    prompt: def.prompt,
    ...(def.backend !== undefined && { backend: def.backend }),
    ...(def.agentDef !== undefined && { agentDef: def.agentDef }),
    ...(def.system !== undefined && { system: def.system }),
    ...(def.systemPromptMode !== undefined && { systemPromptMode: def.systemPromptMode }),
    ...(def.systemPromptIncludeAgentDef !== undefined && {
      systemPromptIncludeAgentDef: def.systemPromptIncludeAgentDef,
    }),
    ...(def.mcp !== undefined && { mcp: def.mcp }),
    ...(def.skills !== undefined && { skills: def.skills }),
    ...(def.secrets !== undefined && { secrets: def.secrets }),
    ...(def.workspace !== undefined && { workspace: def.workspace }),
    ...(def.output !== undefined && { outputSchema: def.output }),
    ...(def.permissions !== undefined && { permissions: def.permissions }),
    ...(def.maxTurns !== undefined && { maxTurns: def.maxTurns }),
    ...(def.timeoutMs !== undefined && { timeoutMs: def.timeoutMs }),
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
    ...(def.when !== undefined && { when: def.when }),
    ...(def.continueOnError !== undefined && { continueOnError: def.continueOnError }),
  })
}

/**
 * Result of a single `check()` step. Recorded as the step's output value so
 * `finalize()` can aggregate it into a `SectionResult` without inspecting the
 * raw `StepResult`. See `@skelm/core/testing` for the aggregation helpers.
 */
export interface TestResult {
  readonly id: string
  readonly status: 'pass' | 'fail' | 'skip'
  readonly message?: string
  /** The value the assertion was expected to observe (for display). */
  readonly expected?: unknown
  /** The value the assertion actually observed. */
  readonly actual?: unknown
  readonly durationMs: number
}

/**
 * Author a test assertion step. `run` should return the observed value (which
 * is recorded as `TestResult.actual`) or throw to signal failure. The step
 * always sets `continueOnError: true` — a failing check records
 * `TestResult { status: 'fail' }` and the pipeline continues to the next
 * check. Use together with `summarizeChecks()` from `@skelm/core/testing` in
 * `finalize`.
 *
 * ```ts
 * check({
 *   id: 'greeting',
 *   permissions: testExecPermissions,
 *   run: async (ctx) => {
 *     const r = await ctx.exec!({ command: 'skelm', args: ['run', 'hello.workflow.mts'] })
 *     const out = JSON.parse(r.stdout)
 *     if (out.greeting !== 'hello, World') throw new Error(`got ${out.greeting}`)
 *     return out
 *   },
 * })
 * ```
 */
export function check(def: {
  id: StepId
  description?: string
  run: (ctx: Context) => unknown | Promise<unknown>
  when?: WhenPredicate
  timeoutMs?: number
  permissions?: AgentPermissions
}): CodeStep<TestResult> {
  if (!def.id) throw new Error('check(): id is required')
  if (typeof def.run !== 'function') {
    throw new Error(`check(${def.id}): run must be a function`)
  }
  const wrapped = async (ctx: Context): Promise<TestResult> => {
    const start = Date.now()
    try {
      const actual = await def.run(ctx)
      return { id: def.id, status: 'pass', actual, durationMs: Date.now() - start }
    } catch (err) {
      return {
        id: def.id,
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      }
    }
  }
  return code<TestResult>({
    id: def.id,
    run: wrapped,
    continueOnError: true,
    ...(def.timeoutMs !== undefined && { timeoutMs: def.timeoutMs }),
    ...(def.permissions !== undefined && { permissions: def.permissions }),
    ...(def.when !== undefined && { when: def.when }),
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
  when?: WhenPredicate
  continueOnError?: boolean
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
    assertNoWaitInside('parallel', def.id, s)
  }
  return Object.freeze({
    kind: 'parallel',
    id: def.id,
    steps: Object.freeze([...def.steps]),
    ...(def.waitFor !== undefined && { waitFor: def.waitFor }),
    ...(def.onError !== undefined && { onError: def.onError }),
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
    ...(def.when !== undefined && { when: def.when }),
    ...(def.continueOnError !== undefined && { continueOnError: def.continueOnError }),
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
  when?: WhenPredicate
  continueOnError?: boolean
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
    ...(def.when !== undefined && { when: def.when }),
    ...(def.continueOnError !== undefined && { continueOnError: def.continueOnError }),
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
  when?: WhenPredicate
  continueOnError?: boolean
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
    ...(def.when !== undefined && { when: def.when }),
    ...(def.continueOnError !== undefined && { continueOnError: def.continueOnError }),
  })
}

/**
 * Iterate a step while a predicate holds, bounded by `maxIterations`.
 *
 * Note: `timeoutMs` on the inner step (e.g. `agent({ timeoutMs })`) bounds
 * each iteration individually, not the total loop wall-clock. A loop with
 * `maxIterations: 20` and a child `timeoutMs: 60_000` may therefore run for
 * up to 20 minutes before the loop itself terminates. There is no built-in
 * cumulative budget; if you need one, gate the run with an outer `AbortSignal`
 * passed via `RunOptions.signal`.
 */
export function loop(def: {
  id: StepId
  while: (ctx: Context) => boolean | Promise<boolean>
  maxIterations: number
  step: Step
  state?: StateConfig
  retry?: RetryPolicy
  when?: WhenPredicate
  continueOnError?: boolean
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
    ...(def.when !== undefined && { when: def.when }),
    ...(def.continueOnError !== undefined && { continueOnError: def.continueOnError }),
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
  when?: WhenPredicate
  continueOnError?: boolean
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
    ...(def.when !== undefined && { when: def.when }),
    ...(def.continueOnError !== undefined && { continueOnError: def.continueOnError }),
  })
}

/** Run a nested pipeline and record its final output as this step's output. */
export function pipelineStep<TInput, TOutput>(def: {
  id: StepId
  pipeline: Pipeline<TInput, TOutput>
  input?: TInput | ((ctx: Context) => TInput)
  state?: StateConfig
  retry?: RetryPolicy
  when?: WhenPredicate
  continueOnError?: boolean
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
    ...(def.when !== undefined && { when: def.when }),
    ...(def.continueOnError !== undefined && { continueOnError: def.continueOnError }),
  })
}

/** Invoke a pipeline looked up by ID from the workflow registry at runtime. */
export function invoke<TOutput>(def: {
  id: string
  pipelineId: string
  input?: unknown | ((ctx: Context) => unknown)
  state?: StateConfig
  retry?: RetryPolicy
  when?: WhenPredicate
  continueOnError?: boolean
}): InvokeStep<unknown, TOutput> {
  if (!def.id) throw new Error('invoke(): id is required')
  if (!def.pipelineId) {
    throw new Error(`invoke(${def.id}): pipelineId is required`)
  }
  assertValidRetryPolicy('invoke', def.id, def.retry)
  return Object.freeze({
    kind: 'invoke',
    id: def.id,
    pipelineId: def.pipelineId,
    ...(def.input !== undefined && { input: def.input }),
    ...(def.state !== undefined && { state: def.state }),
    ...(def.retry !== undefined && { retry: def.retry }),
    ...(def.when !== undefined && { when: def.when }),
    ...(def.continueOnError !== undefined && { continueOnError: def.continueOnError }),
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
  when?: WhenPredicate
  continueOnError?: boolean
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
    ...(def.when !== undefined && { when: def.when }),
    ...(def.continueOnError !== undefined && { continueOnError: def.continueOnError }),
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

// Walk a Step subtree and throw if any descendant is a wait() step.
// wait() inside parallel() has no well-defined semantics today: the runner's
// per-run waitForInput slot is a single Map<runId, ...>, so two concurrent
// arms reaching wait() simultaneously would either overwrite each other's
// slot or drop a resume, leaving an arm suspended indefinitely.
function assertNoWaitInside(containerKind: string, containerId: StepId, step: Step): void {
  if (step.kind === 'wait') {
    throw new Error(
      `${containerKind}(${containerId}): wait(${step.id}) is not allowed inside ${containerKind}() — concurrent waits share a single resume slot and would hang. Move the wait() outside ${containerKind}() or use sequential steps.`,
    )
  }
  switch (step.kind) {
    case 'parallel':
      for (const child of step.steps) assertNoWaitInside(containerKind, containerId, child)
      return
    case 'branch': {
      for (const child of Object.values(step.cases)) {
        assertNoWaitInside(containerKind, containerId, child)
      }
      if (step.default !== undefined) {
        assertNoWaitInside(containerKind, containerId, step.default)
      }
      return
    }
    case 'loop':
    case 'idempotent':
      assertNoWaitInside(containerKind, containerId, step.step)
      return
    case 'pipelineStep':
      // The nested pipeline is embedded directly, so we can recurse statically.
      // (invoke() resolves from a registry at runtime and is left to the
      // runtime to surface; forEach() is factory-built lazily for the same
      // reason.)
      for (const child of step.pipeline.steps) {
        assertNoWaitInside(containerKind, containerId, child)
      }
      return
    default:
      return
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
