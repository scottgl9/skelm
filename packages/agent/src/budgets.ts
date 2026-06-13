/**
 * Agent-harness budgets.
 *
 * The budget primitives now live in `@skelm/core` (`budgets.ts`) so the native
 * agent per-loop budget and the run-level guardrail budget share one tracker
 * and account usage identically. This module re-exports them unchanged; agent
 * passes a `ModelCost` (structurally a `TokenCost`) to the tracker.
 */
export {
  type AgentBudget,
  type AgentBudgetDimension,
  AgentBudgetExceededError,
  BudgetTracker,
  computeTurnCost,
  type TokenCost,
} from '@skelm/core'
