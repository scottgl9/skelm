// Author-facing types for the subagent-orchestrator helpers. These compose the
// merged `ctx.workflows` / `ctx.tasks` primitives in @skelm/core; they neither
// reimplement the orchestration runtime nor the permission math. Every child
// started through these helpers is ceiling-bound by the calling step (the core
// primitive enforces the intersection) — these helpers cannot widen it.

import type { AgentBudget } from '@skelm/agent'
import type {
  AgentPermissions,
  FanoutChildSpec,
  FanoutStrategy,
  WorkflowFanoutResult,
  WorkflowInvokeResult,
} from '@skelm/core'

/** One subagent task: a registered child workflow id plus its input. */
export interface SubagentTask<TInput = unknown> {
  /** Registered child workflow id, resolved via the runtime pipeline registry. */
  readonly workflowId: string
  readonly input?: TInput
}

/** Options shared by every fan-out helper. */
export interface FanOutOptions<TOutput = unknown> {
  /** The child tasks to run. One child per entry. */
  readonly tasks: readonly SubagentTask[]
  /** Merge strategy; defaults to `wait-all`. */
  readonly strategy?: FanoutStrategy
  /** Max children in flight at once. Forwarded to the core fanout (capped at 16). */
  readonly concurrency?: number
  /** `wait-all` only: record failures in the result instead of throwing. */
  readonly continueOnError?: boolean
  /** Required for `quorum`: number of completed children that resolves the fan-out. */
  readonly quorum?: number
  /** Required for `ranked-merge`: comparator ordering the merged results. */
  readonly rank?: (a: WorkflowInvokeResult<TOutput>, b: WorkflowInvokeResult<TOutput>) => number
  /**
   * Optional narrower permission ceiling applied to every child. Narrowing
   * only: the core primitive intersects it with the calling step's policy, so
   * a child can never exceed the parent.
   */
  readonly ceiling?: AgentPermissions
}

/** Lineage record for one completed/attempted child. */
export interface SubagentLineage {
  readonly workflowId: string
  /** The child run id — correlates with parent run lineage queries. */
  readonly runId: string
  readonly status: WorkflowInvokeResult['status']
}

/**
 * Typed envelope returned by the fan-out helpers. Wraps the core
 * `WorkflowFanoutResult` and adds the parent/child lineage tree so callers do
 * not have to reconstruct it from the per-child envelopes.
 */
export interface FanOutResult<TOutput = unknown> extends WorkflowFanoutResult<TOutput> {
  /** The orchestrating (parent) run id. */
  readonly parentRunId: string
  /** Parent → child lineage, one entry per settled child. */
  readonly lineage: readonly SubagentLineage[]
}

/** Kind of subagent role for the recipe; informational, threaded into child input. */
export type SubagentRole = 'research' | 'coding' | 'review'

/** Per-child spec for {@link runSubagents}. */
export interface SubagentSpec<TInput = unknown> {
  readonly workflowId: string
  readonly input?: TInput
  /**
   * Per-child agent-harness budget (token / cost / tool-call / wall-clock).
   * Threaded into the child input under `budget` so the child's agent step
   * applies it via the agent harness. A SAFETY LIMIT, never a permission.
   */
  readonly budget?: AgentBudget
}

/** Options for the parameterized research/coding/review recipe. */
export interface RunSubagentsOptions<TInput = unknown, TOutput = unknown> {
  readonly role: SubagentRole
  readonly children: readonly SubagentSpec<TInput>[]
  readonly strategy?: FanoutStrategy
  readonly concurrency?: number
  readonly continueOnError?: boolean
  readonly quorum?: number
  readonly rank?: (a: WorkflowInvokeResult<TOutput>, b: WorkflowInvokeResult<TOutput>) => number
  readonly ceiling?: AgentPermissions
  /** Default budget applied to children that do not set their own. */
  readonly defaultBudget?: AgentBudget
}

/** The child-input envelope the recipe threads to each subagent. */
export interface SubagentInput<TInput = unknown> {
  readonly role: SubagentRole
  readonly parentRunId: string
  readonly payload?: TInput
  /** Present when a budget was supplied; the child agent step applies it. */
  readonly budget?: AgentBudget
}

export type { FanoutChildSpec }
