/**
 * Agent-harness budgets — self-contained safety limits for the native
 * `@skelm/agent` loop.
 *
 * Budgets are a SAFETY LIMIT, not a permission dimension. They abort a run
 * deterministically when a cumulative ceiling is crossed; they never widen
 * anything and never touch the resolved permission policy. Default is no
 * budget (unbounded — unchanged behavior). These are distinct from skelm's
 * core durable HITL / oversight primitives.
 */

import type { ModelCost } from './models/types.js'

/**
 * Cumulative safety ceilings for one `run()` agent loop. Every field is
 * optional; an omitted field is unbounded. All ceilings are *cumulative
 * across turns*, distinct from the per-call `maxTokens` output cap (which
 * limits a single completion) and from `maxTurns` (which caps turn count).
 */
export interface AgentBudget {
  /**
   * Cumulative token ceiling across every turn of the run (sum of input +
   * output tokens reported by each turn's `Usage`). Named `tokenBudget` to
   * make clear it is the run-wide budget, not the per-call `max_tokens`.
   */
  tokenBudget?: number
  /** Cumulative estimated USD cost ceiling across the run. */
  maxCostUsd?: number
  /** Maximum number of tool-call dispatches across the run. */
  maxToolCalls?: number
  /** Wall-clock ceiling in milliseconds, measured from loop start. */
  maxWallClockMs?: number
}

/** Which budget dimension tripped, for `AgentBudgetExceededError`. */
export type AgentBudgetDimension = 'tokens' | 'cost' | 'toolCalls' | 'wallClock'

/**
 * Thrown when a run crosses an `AgentBudget` ceiling. Carries the dimension
 * that tripped plus the observed value and the configured limit so callers
 * can report or retry with a larger budget. A `run.warning` (code
 * `agent.budget.<dimension>`) is emitted before this throws, so the abort is
 * observable in the event log.
 */
export class AgentBudgetExceededError extends Error {
  override readonly name = 'AgentBudgetExceededError'
  constructor(
    readonly dimension: AgentBudgetDimension,
    readonly observed: number,
    readonly limit: number,
    readonly backendId?: string,
  ) {
    super(
      `agent budget exceeded: ${dimension} reached ${observed} (limit ${limit})${
        backendId !== undefined ? ` [${backendId}]` : ''
      }`,
    )
  }
}

/**
 * Tracks cumulative usage for one run and decides when a budget trips.
 * Stateless across runs — one tracker per `runAgentLoop` invocation.
 */
export class BudgetTracker {
  private tokens = 0
  private costUsd = 0
  private toolCalls = 0
  private readonly startedAt: number

  constructor(
    private readonly budget: AgentBudget | undefined,
    private readonly cost: ModelCost | undefined,
    now: number = Date.now(),
  ) {
    this.startedAt = now
  }

  get hasBudget(): boolean {
    return this.budget !== undefined
  }

  /** Cumulative token count observed so far. */
  get totalTokens(): number {
    return this.tokens
  }

  /** Cumulative estimated cost so far, in USD. */
  get totalCostUsd(): number {
    return this.costUsd
  }

  /** Cumulative tool-call dispatch count so far. */
  get totalToolCalls(): number {
    return this.toolCalls
  }

  /** Wall-clock elapsed since the tracker was constructed, in ms. */
  elapsedMs(now: number = Date.now()): number {
    return now - this.startedAt
  }

  /**
   * Fold one turn's token usage into the running totals. `inputTokens` and
   * `outputTokens` come straight from the turn's `Usage`. When a per-token
   * cost shape is known, the turn's cost is accumulated; otherwise an
   * upstream-supplied `costUsd` (if any) is added as-is.
   */
  addUsage(
    usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined,
  ): void {
    if (usage === undefined) return
    const input = usage.inputTokens ?? 0
    const output = usage.outputTokens ?? 0
    this.tokens += input + output
    this.costUsd += computeTurnCost(input, output, this.cost, usage.costUsd)
  }

  /** Record a tool-call dispatch toward the `maxToolCalls` ceiling. */
  addToolCall(): void {
    this.toolCalls += 1
  }

  /**
   * Return the dimension/observed/limit triple for the first ceiling that
   * is currently exceeded, or `undefined` when within budget. Checked after
   * each turn's usage is folded in and after each tool-call increment.
   */
  exceeded(
    now: number = Date.now(),
  ): { dimension: AgentBudgetDimension; observed: number; limit: number } | undefined {
    const b = this.budget
    if (b === undefined) return undefined
    if (b.tokenBudget !== undefined && this.tokens > b.tokenBudget) {
      return { dimension: 'tokens', observed: this.tokens, limit: b.tokenBudget }
    }
    if (b.maxCostUsd !== undefined && this.costUsd > b.maxCostUsd) {
      return { dimension: 'cost', observed: this.costUsd, limit: b.maxCostUsd }
    }
    if (b.maxToolCalls !== undefined && this.toolCalls > b.maxToolCalls) {
      return { dimension: 'toolCalls', observed: this.toolCalls, limit: b.maxToolCalls }
    }
    if (b.maxWallClockMs !== undefined && this.elapsedMs(now) > b.maxWallClockMs) {
      return { dimension: 'wallClock', observed: this.elapsedMs(now), limit: b.maxWallClockMs }
    }
    return undefined
  }
}

/**
 * Estimate the USD cost of one turn. When a `ModelCost` shape is known the
 * cost is derived from per-1K input/output token prices; otherwise the
 * upstream-reported `costUsd` (if any) is used verbatim. Returns 0 when
 * neither is available so cost accounting never blocks a run with no pricing.
 */
export function computeTurnCost(
  inputTokens: number,
  outputTokens: number,
  cost: ModelCost | undefined,
  upstreamCostUsd: number | undefined,
): number {
  if (cost !== undefined) {
    return (inputTokens / 1000) * cost.input + (outputTokens / 1000) * cost.output
  }
  return upstreamCostUsd ?? 0
}
