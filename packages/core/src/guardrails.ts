/**
 * Run-level guardrails & agent oversight.
 *
 * Guardrails are a RUN/WORKFLOW-level oversight layer that sits above the
 * agent-harness self-checks (`@skelm/agent` `AgentBudget` / `outputValidators`
 * / `toolValidators`, which gate a single agent loop). A guardrail config is
 * declared on the workflow (`Pipeline.guardrails`) and optionally overlaid by
 * the trust boundary (gateway). It produces structured, audited results across
 * three phases:
 *
 *   1. PRE-RUN — validators that run before the first step. A failing HARD
 *      check blocks the run start (fail closed); a soft check warns and
 *      proceeds. Audited as `guardrail.pre`.
 *   2. IN-RUN — token / cost / tool-call / wall-clock BUDGETS (reusing the
 *      core `AgentBudget` tracker), an idle/wall-clock WATCHDOG, and an
 *      optional SUPERVISOR/CRITIC callback that inspects progress and may
 *      request an intervention. Interventions (pause / escalate / terminate)
 *      are realized through the durable HITL gate primitive and the run abort
 *      signal. Audited as `guardrail.intervention`.
 *   3. POST-RUN — validators on the final output (schema / expected-behavior /
 *      artifact checks) plus an optional quality score. A failing post-run
 *      check marks the run guardrail-failed. Audited as `guardrail.post`.
 *
 * Security: pre-run checks fail CLOSED — a hard failure (or a validator that
 * throws) blocks the run before any step body runs, so a guardrail can never
 * be bypassed by a step that would otherwise execute. Every decision and
 * intervention is emitted on the run event bus and persisted through the single
 * gateway audit writer. Guardrail code MUST NOT place secret values into result
 * messages, details, or scores.
 */

import type { AgentBudget } from './budgets.js'
import type { HitlGate } from './hitl.js'
import type { ResolvedPolicy } from './permissions.js'
import type { Context, Pipeline, Run, StepId } from './types.js'

/** Outcome severity of a single guardrail check. */
export type GuardrailStatus = 'pass' | 'warn' | 'fail'

/** Which phase a guardrail result belongs to. */
export type GuardrailPhase = 'pre' | 'in' | 'post'

/**
 * Structured result of one guardrail check. `status: 'fail'` on a HARD check
 * blocks (pre-run) or marks the run guardrail-failed (post-run); `'warn'` is
 * advisory. `score` is an optional 0..1 quality signal (post-run report).
 */
export interface GuardrailResult {
  /** Stable id of the check that produced this result. */
  readonly check: string
  readonly status: GuardrailStatus
  /** Human-readable reason; never include secret values. */
  readonly message?: string
  /** Optional 0..1 quality score surfaced in the post-run report. */
  readonly score?: number
  /** Free-form, non-secret structured detail for the dashboard/audit. */
  readonly details?: Readonly<Record<string, unknown>>
}

/** Context handed to a pre-run validator, before any step body runs. */
export interface PreRunContext {
  readonly runId: string
  readonly pipelineId: string
  readonly input: unknown
  /**
   * Effective resolved policies for the run's agent/code steps, keyed by step
   * id, for effective-permission review. Populated when the trust boundary
   * pre-resolves policies; empty for in-process runs that resolve per step.
   */
  readonly resolvedPolicies?: Readonly<Record<StepId, ResolvedPolicy>>
  /** Operator environment label (e.g. 'production'), when configured. */
  readonly environment?: string
}

/** Context handed to a post-run validator, after the run produced its output. */
export interface PostRunContext {
  readonly runId: string
  readonly pipelineId: string
  /** The final run record (status, steps, output, error). */
  readonly run: Run
}

/**
 * A pre-run validator. Returning `fail` with `severity: 'hard'` BLOCKS the run
 * (fail closed); `warn`/soft proceeds. Throwing is treated as a hard fail —
 * pre-run validators fail closed.
 */
export interface PreRunValidator {
  readonly id: string
  /** `'hard'` (default) blocks on fail; `'soft'` only warns. */
  readonly severity?: 'hard' | 'soft'
  validate(ctx: PreRunContext): GuardrailResult | Promise<GuardrailResult>
}

/**
 * A post-run validator. A `fail` marks the run guardrail-failed (a hard fail is
 * recorded in the run's guardrail report). Throwing is treated as a hard fail.
 */
export interface PostRunValidator {
  readonly id: string
  readonly severity?: 'hard' | 'soft'
  validate(ctx: PostRunContext): GuardrailResult | Promise<GuardrailResult>
}

/** What an oversight intervention does. */
export type InterventionAction = 'pause' | 'escalate' | 'terminate'

/**
 * A request to intervene in an in-flight run, returned by the supervisor/critic
 * or raised by a budget/watchdog breach. `pause`/`escalate` are realized as a
 * durable HITL gate; `terminate` cancels the run.
 */
export interface InterventionRequest {
  readonly action: InterventionAction
  /** Human-readable reason; never include secret values. */
  readonly reason: string
  /**
   * Gate used for `pause`/`escalate`. Omitted ⇒ a default approval gate is
   * synthesized (terminate ignores it).
   */
  readonly gate?: HitlGate
}

/** Progress snapshot handed to the supervisor/critic hook after each step. */
export interface SupervisorContext {
  readonly runId: string
  readonly pipelineId: string
  /** Step that just completed (or failed), when the probe fired after a step. */
  readonly lastStepId?: StepId
  /** Cumulative budget consumption observed so far, when a budget is configured. */
  readonly usage?: {
    readonly tokens: number
    readonly costUsd: number
    readonly toolCalls: number
    readonly elapsedMs: number
  }
  /** Read-only run context at the probe point. */
  readonly ctx: Context
}

/**
 * Supervisor/critic hook: inspects run progress and may request an
 * intervention. A pure callback (no LLM calls inside the runtime — an
 * LLM-backed critic is the operator's responsibility outside this hook).
 * Returning `undefined` lets the run continue.
 */
export type SupervisorHook = (
  ctx: SupervisorContext,
) => InterventionRequest | undefined | Promise<InterventionRequest | undefined>

/** Watchdog bounds. A breach raises the configured `onBreach` intervention. */
export interface WatchdogConfig {
  /** Wall-clock ceiling for the whole run, in ms. */
  readonly maxRunMs?: number
  /** Idle ceiling: max ms between two step completions before a breach. */
  readonly maxIdleMs?: number
  /** Intervention raised on a breach. Default: 'terminate'. */
  readonly onBreach?: InterventionAction
}

/** Intervention applied when an in-run budget ceiling is crossed. */
export type BudgetOnBreach = InterventionAction

/**
 * The run-level guardrail config. Declared on a workflow (`Pipeline.guardrails`)
 * and optionally narrowed/overlaid by the trust boundary. Every field is
 * optional; an empty config imposes nothing (unchanged behavior).
 */
export interface GuardrailsConfig {
  /** Pre-run validators (policy/permission/model/profile/approval review). */
  readonly preRun?: readonly PreRunValidator[]
  /**
   * Run-level cumulative budget (tokens / cost / tool-calls / wall-clock),
   * reusing the core `AgentBudget` shape. A breach raises `budgetOnBreach`.
   */
  readonly budget?: AgentBudget
  /** Intervention raised on a budget breach. Default: 'terminate'. */
  readonly budgetOnBreach?: BudgetOnBreach
  /** Wall-clock / idle watchdog. */
  readonly watchdog?: WatchdogConfig
  /** Supervisor/critic progress hook. */
  readonly supervisor?: SupervisorHook
  /** Post-run validators (output schema / expected-behavior / artifact / quality). */
  readonly postRun?: readonly PostRunValidator[]
}

/**
 * Policy-overlay hook supplied ONLY by the trust boundary (gateway config),
 * never by workflow authors. Given the author's config (if any), it returns the
 * effective config the runtime enforces. Use it to inject mandatory pre/post
 * validators, a budget ceiling, or a watchdog the author cannot remove. The
 * overlay's result is authoritative.
 */
export type GuardrailsPolicy = (
  authored: GuardrailsConfig | undefined,
  pipeline: Pick<Pipeline, 'id'>,
) => GuardrailsConfig | undefined

/** Effective severity of a pre-run validator; defaults to 'hard' (fail closed). */
export function preRunSeverity(v: PreRunValidator): 'hard' | 'soft' {
  return v.severity ?? 'hard'
}

/** Effective severity of a post-run validator; defaults to 'hard'. */
export function postRunSeverity(v: PostRunValidator): 'hard' | 'soft' {
  return v.severity ?? 'hard'
}

/** Resolve the effective guardrails config: a policy overlay wins over the author's. */
export function resolveGuardrails(
  authored: GuardrailsConfig | undefined,
  policy: GuardrailsPolicy | undefined,
  pipeline: Pick<Pipeline, 'id'>,
): GuardrailsConfig | undefined {
  if (policy === undefined) return authored
  return policy(authored, pipeline)
}
