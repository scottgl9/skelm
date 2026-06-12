/**
 * Agent-harness run metrics — token, cost, and latency accounting surfaced
 * by the native `@skelm/agent` loop.
 *
 * The numbers are computed by the loop's `BudgetTracker` (reused so budgets
 * and metrics never disagree) and surfaced two ways:
 *
 *   1. On `AgentResponse.usage` — `costUsd` plus a `metrics.*` shape under
 *      `usage.extras` (turns, tool calls, wall-clock ms).
 *   2. As a structured `run.warning` (code `agent.metrics`) when the run has
 *      an event sink, so a dashboard / the @skelm/metrics collector can see
 *      per-run token/cost/latency without parsing the final result.
 */

/** Per-run metrics snapshot for one `run()` agent loop. */
export interface AgentRunMetrics {
  /** Cumulative input + output tokens across every turn. */
  totalTokens: number
  /** Cumulative estimated cost in USD (0 when no pricing is known). */
  totalCostUsd: number
  /** Number of tool-call dispatches across the run. */
  toolCalls: number
  /** Number of LLM turns taken. */
  turns: number
  /** Wall-clock duration of the loop, in milliseconds. */
  wallClockMs: number
}

/** The `run.warning` code carrying per-run agent metrics. */
export const AGENT_METRICS_WARNING_CODE = 'agent.metrics'
