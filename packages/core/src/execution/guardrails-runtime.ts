/**
 * Runtime execution of run-level guardrails & oversight.
 *
 * Three entry points the runner calls:
 *
 *   - `runPreRunGuardrails` — before the first step. Runs every pre-run
 *     validator, emits a `guardrail.pre` event per result, and throws
 *     `GuardrailBlockedError` if any HARD check fails (fail closed). A validator
 *     that throws is treated as a hard fail, so a thrown validator also blocks.
 *   - `OversightController` — the in-run layer. It folds usage into a
 *     `BudgetTracker` (reusing the core budget primitive), arms a wall-clock /
 *     idle watchdog, and runs the supervisor/critic after each step. A budget
 *     breach, watchdog breach, or supervisor request is applied as a pause /
 *     escalate (durable HITL gate) or terminate (run abort).
 *   - `runPostRunGuardrails` — after the run produced its output. Runs every
 *     post-run validator, emits `guardrail.post`, and returns a report whose
 *     `failed` flag the runner uses to mark the run guardrail-failed.
 *
 * Security: pre-run fails closed; a guardrail can never be skipped by a step
 * that would otherwise run because pre-run runs before the step loop. Every
 * decision and intervention is emitted on the event bus (and thus audited and
 * persisted). Messages/details must never carry secret values.
 */

import { type AgentBudget, BudgetTracker } from '../budgets.js'
import { GuardrailBlockedError } from '../errors.js'
import {
  type GuardrailResult,
  type GuardrailsConfig,
  type InterventionAction,
  type InterventionRequest,
  type PostRunContext,
  type PostRunValidator,
  type PreRunContext,
  type PreRunValidator,
  type SupervisorContext,
  postRunSeverity,
  preRunSeverity,
} from '../guardrails.js'
import type { HitlGate } from '../hitl.js'
import { toHitlPending } from '../hitl.js'
import type { Context, RunGuardrailReport, StepId } from '../types.js'

interface EventsLike {
  publish(event: unknown): void
}

type WaitFn = (request: {
  runId: string
  pipelineId: string
  stepId: string
  signal: AbortSignal
  message?: string
  timeoutMs?: number
  hitl?: ReturnType<typeof toHitlPending>
}) => Promise<unknown>

/** Source label for an intervention, carried on events/audit. */
type InterventionSource = 'budget' | 'watchdog' | 'supervisor'

function severityFail(result: GuardrailResult, severity: 'hard' | 'soft'): boolean {
  return result.status === 'fail' && severity === 'hard'
}

/**
 * Run pre-run validators. Emits a `guardrail.pre` per result and throws
 * `GuardrailBlockedError` when any HARD validator fails or throws (fail closed).
 */
export async function runPreRunGuardrails(
  validators: readonly PreRunValidator[],
  ctx: PreRunContext,
  events: EventsLike | undefined,
): Promise<readonly GuardrailResult[]> {
  const results: GuardrailResult[] = []
  const failedHard: string[] = []
  for (const validator of validators) {
    const severity = preRunSeverity(validator)
    let result: GuardrailResult
    try {
      result = await validator.validate(ctx)
    } catch (err) {
      // A throwing pre-run validator fails closed.
      result = {
        check: validator.id,
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
      }
    }
    results.push(result)
    emitPhase(events, 'guardrail.pre', ctx.runId, result, severity)
    if (severityFail(result, severity)) failedHard.push(result.check)
  }
  if (failedHard.length > 0) {
    throw new GuardrailBlockedError(ctx.runId, failedHard)
  }
  return results
}

/**
 * Run post-run validators. Emits a `guardrail.post` per result and returns a
 * report. `failed` is true when any HARD validator fails or throws.
 */
export async function runPostRunGuardrails(
  validators: readonly PostRunValidator[],
  ctx: PostRunContext,
  events: EventsLike | undefined,
  priorResults: readonly GuardrailResult[] = [],
  priorInterventions: RunGuardrailReport['interventions'] = undefined,
): Promise<RunGuardrailReport> {
  const results: GuardrailResult[] = [...priorResults]
  let failed = priorInterventions?.some((i) => i.action === 'terminate') ?? false
  for (const validator of validators) {
    const severity = postRunSeverity(validator)
    let result: GuardrailResult
    try {
      result = await validator.validate(ctx)
    } catch (err) {
      result = {
        check: validator.id,
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
      }
    }
    results.push(result)
    emitPhase(events, 'guardrail.post', ctx.runId, result, severity)
    if (severityFail(result, severity)) failed = true
  }
  return {
    failed,
    results,
    ...(priorInterventions !== undefined &&
      priorInterventions.length > 0 && { interventions: priorInterventions }),
  }
}

function emitPhase(
  events: EventsLike | undefined,
  type: 'guardrail.pre' | 'guardrail.post',
  runId: string,
  result: GuardrailResult,
  severity: 'hard' | 'soft',
): void {
  events?.publish({
    type,
    runId,
    check: result.check,
    status: result.status,
    severity,
    ...(result.message !== undefined && { message: result.message }),
    ...(result.score !== undefined && { score: result.score }),
    ...(result.details !== undefined && { details: result.details }),
    at: Date.now(),
  })
}

/**
 * In-run oversight: budget tracking, watchdog, supervisor/critic, and the
 * pause/escalate/terminate intervention machinery. One controller per run; the
 * runner folds usage into it, calls `probe()` after each step, and `abort()`s
 * the run when an intervention terminates it.
 */
export class OversightController {
  private readonly tracker: BudgetTracker
  private readonly interventions: NonNullable<RunGuardrailReport['interventions']>[number][] = []
  private lastActivity: number
  private terminated = false

  constructor(
    private readonly config: GuardrailsConfig,
    private readonly runId: string,
    private readonly pipelineId: string,
    private readonly events: EventsLike | undefined,
    private readonly abort: (reason: string) => void,
    private readonly waitForInput: WaitFn | undefined,
    private readonly signal: AbortSignal,
    now: number = Date.now(),
  ) {
    this.tracker = new BudgetTracker(config.budget, undefined, now)
    this.lastActivity = now
  }

  /** True once an intervention has terminated the run. */
  get isTerminated(): boolean {
    return this.terminated
  }

  /** Recorded interventions for the run's guardrail report. */
  get recordedInterventions(): RunGuardrailReport['interventions'] {
    return this.interventions.length > 0 ? this.interventions : undefined
  }

  /** Fold one step's reported token usage into the run-level budget. */
  addUsage(usage: { inputTokens?: number; outputTokens?: number; costUsd?: number }): void {
    this.tracker.addUsage(usage)
  }

  /** Record a tool-call dispatch toward the run-level `maxToolCalls` budget. */
  addToolCall(): void {
    this.tracker.addToolCall()
  }

  private usageSnapshot(now: number): SupervisorContext['usage'] {
    if (this.config.budget === undefined) return undefined
    return {
      tokens: this.tracker.totalTokens,
      costUsd: this.tracker.totalCostUsd,
      toolCalls: this.tracker.totalToolCalls,
      elapsedMs: this.tracker.elapsedMs(now),
    }
  }

  /**
   * Oversight probe run after each step. Checks budget + watchdog bounds and
   * the supervisor/critic, applies the first intervention raised. Returns the
   * applied intervention's action when one fired, else undefined. The runner
   * calls this between steps; on a returned `terminate` the run aborts.
   */
  async probe(
    ctx: Context,
    lastStepId: StepId | undefined,
  ): Promise<InterventionAction | undefined> {
    const now = Date.now()
    // Budget breach (reuses the core BudgetTracker — same accounting as the
    // agent harness).
    const breach = this.tracker.exceeded(now)
    if (breach !== undefined) {
      const action = this.config.budgetOnBreach ?? 'terminate'
      return this.intervene(
        {
          action,
          reason: `budget exceeded: ${breach.dimension} reached ${breach.observed} (limit ${breach.limit})`,
        },
        'budget',
        ctx,
        lastStepId,
        { dimension: breach.dimension, observed: breach.observed, limit: breach.limit },
      )
    }
    // Watchdog: wall-clock + idle bounds.
    const wd = this.config.watchdog
    if (wd !== undefined) {
      if (wd.maxRunMs !== undefined && this.tracker.elapsedMs(now) > wd.maxRunMs) {
        return this.intervene(
          {
            action: wd.onBreach ?? 'terminate',
            reason: `run exceeded watchdog maxRunMs=${wd.maxRunMs}`,
          },
          'watchdog',
          ctx,
          lastStepId,
          { bound: 'maxRunMs', limit: wd.maxRunMs },
        )
      }
      if (wd.maxIdleMs !== undefined && now - this.lastActivity > wd.maxIdleMs) {
        return this.intervene(
          {
            action: wd.onBreach ?? 'terminate',
            reason: `run idle beyond watchdog maxIdleMs=${wd.maxIdleMs}`,
          },
          'watchdog',
          ctx,
          lastStepId,
          { bound: 'maxIdleMs', limit: wd.maxIdleMs },
        )
      }
    }
    this.lastActivity = now
    // Supervisor/critic. A crashing oversight hook must FAIL CLOSED — terminate
    // the run rather than let the exception propagate and be swallowed (e.g. on
    // a continueOnError step), which would silently drop oversight and run the
    // remaining steps unsupervised. Mirrors the pre/post validator handling.
    if (this.config.supervisor !== undefined) {
      let request: InterventionRequest | undefined
      try {
        request = await this.config.supervisor({
          runId: this.runId,
          pipelineId: this.pipelineId,
          ...(lastStepId !== undefined && { lastStepId }),
          ...(this.usageSnapshot(now) !== undefined && {
            usage: this.usageSnapshot(now) as NonNullable<SupervisorContext['usage']>,
          }),
          ctx,
        })
      } catch (err) {
        const reason = `supervisor hook failed: ${err instanceof Error ? err.message : String(err)}`
        return this.intervene({ action: 'terminate', reason }, 'supervisor', ctx, lastStepId)
      }
      if (request !== undefined) {
        return this.intervene(request, 'supervisor', ctx, lastStepId)
      }
    }
    return undefined
  }

  /**
   * Apply an intervention. `terminate` aborts the run (the runner observes the
   * abort and finalizes as cancelled); `pause`/`escalate` open a durable HITL
   * gate that blocks until a human resolves it. Every intervention is emitted
   * as `guardrail.intervention` (audited) and recorded for the report.
   */
  private async intervene(
    request: InterventionRequest,
    source: InterventionSource,
    ctx: Context,
    stepId: StepId | undefined,
    details?: Record<string, unknown>,
  ): Promise<InterventionAction> {
    this.events?.publish({
      type: 'guardrail.intervention',
      runId: this.runId,
      ...(stepId !== undefined && { stepId }),
      action: request.action,
      source,
      reason: request.reason,
      ...(details !== undefined && { details }),
      at: Date.now(),
    })
    // Record the EFFECTIVE action, not the requested one: a pause/escalate that
    // degrades to termination (no handler, or a rejected hold) must be recorded
    // as 'terminate' so the guardrail report's `failed` flag — which keys off
    // interventions with action 'terminate' — reflects that the run was killed.
    const record = (action: InterventionAction): void => {
      this.interventions.push({ action, source, reason: request.reason })
    }
    if (request.action === 'terminate') {
      record('terminate')
      this.terminated = true
      this.abort(request.reason)
      return 'terminate'
    }
    // pause / escalate → durable HITL gate. Without a wait/resume handler the
    // pause cannot block, so we degrade to terminate (fail closed) rather than
    // silently continuing past an oversight hold.
    if (this.waitForInput === undefined) {
      record('terminate')
      this.terminated = true
      this.abort(`${request.reason} (no wait/resume handler for oversight ${request.action})`)
      return 'terminate'
    }
    const gate: HitlGate =
      request.gate ??
      (request.action === 'escalate'
        ? { kind: 'approval', reason: request.reason, onTimeout: 'escalate' }
        : { kind: 'approval', reason: request.reason })
    const pending = toHitlPending(gate, 'afterOutput', undefined, true)
    this.events?.publish({
      type: 'run.waiting',
      runId: this.runId,
      stepId: stepId ?? '__oversight__',
      message: request.reason,
      hitl: pending,
      at: Date.now(),
    })
    const raw = await this.waitForInput({
      runId: this.runId,
      pipelineId: this.pipelineId,
      stepId: stepId ?? '__oversight__',
      signal: this.signal,
      message: request.reason,
      hitl: pending,
    })
    this.events?.publish({
      type: 'run.resumed',
      runId: this.runId,
      stepId: stepId ?? '__oversight__',
      output: raw,
      at: Date.now(),
    })
    // A denied/false decision on the oversight gate terminates the run.
    const approved =
      raw === true ||
      (raw !== null && typeof raw === 'object' && (raw as { approved?: unknown }).approved === true)
    if (!approved) {
      record('terminate')
      this.terminated = true
      this.abort(`${request.reason} (oversight ${request.action} rejected)`)
      return 'terminate'
    }
    // The hold was approved: the run continues. Record the original action so
    // the report shows the oversight intervention without flagging a failure.
    record(request.action)
    return request.action
  }
}

/** Build the pre-run context fed to pre-run validators. */
export function buildPreRunContext(opts: {
  runId: string
  pipelineId: string
  input: unknown
  resolvedPolicies?: PreRunContext['resolvedPolicies']
  environment?: string
}): PreRunContext {
  return {
    runId: opts.runId,
    pipelineId: opts.pipelineId,
    input: opts.input,
    ...(opts.resolvedPolicies !== undefined && { resolvedPolicies: opts.resolvedPolicies }),
    ...(opts.environment !== undefined && { environment: opts.environment }),
  }
}
