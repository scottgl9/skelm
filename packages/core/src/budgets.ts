/**
 * Cumulative usage budgets — pure, self-contained safety ceilings.
 *
 * A budget is a SAFETY LIMIT, not a permission dimension. It aborts work
 * deterministically when a cumulative ceiling is crossed; it never widens
 * anything and never touches the resolved permission policy. Default is no
 * budget (unbounded). These primitives back two layers that must not diverge:
 *
 *   - the native `@skelm/agent` per-loop budget (re-exported from here), and
 *   - the run-level guardrail budget (see `guardrails.ts`),
 *
 * so both account tokens / cost / tool-calls / wall-clock the same way.
 */

/** Per-1K-token cost shape used to estimate cumulative USD cost. */
export interface TokenCost {
  /** Cost per 1K input tokens, in USD. */
  readonly input: number
  /** Cost per 1K output tokens, in USD. */
  readonly output: number
}

/**
 * Cumulative safety ceilings. Every field is optional; an omitted field is
 * unbounded. All ceilings are *cumulative* (across turns for an agent loop,
 * across steps for a run), distinct from a per-call `maxTokens` output cap and
 * from `maxTurns`.
 */
export interface AgentBudget {
  /**
   * Cumulative token ceiling (sum of input + output tokens). Named
   * `tokenBudget` to make clear it is the run-wide budget, not the per-call
   * `max_tokens`.
   */
  tokenBudget?: number
  /** Cumulative estimated USD cost ceiling. */
  maxCostUsd?: number
  /** Maximum number of tool-call dispatches. */
  maxToolCalls?: number
  /** Wall-clock ceiling in milliseconds, measured from tracker start. */
  maxWallClockMs?: number
}

/** Which budget dimension tripped, for `AgentBudgetExceededError`. */
export type AgentBudgetDimension = 'tokens' | 'cost' | 'toolCalls' | 'wallClock'

/**
 * Thrown when a budget ceiling is crossed. Carries the dimension that tripped
 * plus the observed value and the configured limit so callers can report or
 * retry with a larger budget. A `run.warning` is emitted before this throws so
 * the abort is observable in the event log.
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
 * Tracks cumulative usage and decides when a budget trips. Stateless across
 * runs — one tracker per loop / run.
 */
export class BudgetTracker {
  private tokens = 0
  private costUsd = 0
  private toolCalls = 0
  private readonly startedAt: number

  constructor(
    private readonly budget: AgentBudget | undefined,
    private readonly cost: TokenCost | undefined,
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
   * Fold one increment of token usage into the running totals. When a per-token
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
   * Return the dimension/observed/limit triple for the first ceiling currently
   * exceeded, or `undefined` when within budget.
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
 * Estimate the USD cost of one usage increment. When a `TokenCost` shape is
 * known the cost is derived from per-1K input/output token prices; otherwise
 * the upstream-reported `costUsd` (if any) is used verbatim. Returns 0 when
 * neither is available so cost accounting never blocks with no pricing.
 */
export function computeTurnCost(
  inputTokens: number,
  outputTokens: number,
  cost: TokenCost | undefined,
  upstreamCostUsd: number | undefined,
): number {
  if (cost !== undefined) {
    return (inputTokens / 1000) * cost.input + (outputTokens / 1000) * cost.output
  }
  return upstreamCostUsd ?? 0
}
