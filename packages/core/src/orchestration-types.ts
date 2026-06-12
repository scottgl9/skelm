// Author-facing types for the in-workflow orchestration helpers exposed on
// Context (`ctx.workflows`, `ctx.tasks`). Every child started through these
// handles runs under the existing delegation ceiling: its resolved policy is
// intersected with the calling step's resolved policy, so a child can never
// exceed the parent that started it. Type-only imports keep this a leaf
// module that types.ts can inline-import without a runtime cycle.

import type { RunEvent } from './events.js'
import type { AgentPermissions } from './permissions.js'
import type { DeliveryTarget, TaskRecord } from './run-store/types.js'
import type { SerializedError } from './types-base.js'

/** Terminal outcome of a child workflow started via `ctx.workflows`. */
export type WorkflowInvokeStatus = 'completed' | 'failed' | 'cancelled'

/** Typed result envelope returned by `ctx.workflows.invoke` and per fanout child. */
export interface WorkflowInvokeResult<TOutput = unknown> {
  readonly status: WorkflowInvokeStatus
  /** The child run id, for correlation in events / lineage queries. */
  readonly runId: string
  /** The child's final output (present when `status === 'completed'`). */
  readonly output?: TOutput
  /** The child run's error (present when the child failed with one). */
  readonly error?: SerializedError
}

export interface WorkflowInvokeOptions {
  /** Id of the pipeline to run, resolved via the runtime's pipeline registry. */
  readonly pipelineId: string
  readonly input?: unknown
  /**
   * Optional narrower ceiling for the child. Resolved without operator grants
   * and intersected with the calling step's resolved policy — narrowing only,
   * a requested ceiling can never widen past the caller.
   */
  readonly ceiling?: AgentPermissions
}

/**
 * Merge strategy for `ctx.workflows.fanout`:
 *  - `wait-all`: wait for every child; throws `FanoutFailedError` when any
 *    child does not complete, unless `continueOnError` is set.
 *  - `fail-fast`: reject on the first non-completed child and cancel the rest.
 *  - `best-effort`: wait for every child; never throws — collect successes and
 *    record failures.
 *  - `quorum`: resolve as soon as `quorum` children complete and cancel the
 *    rest; throws `FanoutFailedError` when the quorum becomes unreachable.
 *  - `first-success`: resolve on the first completed child and cancel the
 *    rest; throws `FanoutFailedError` when every child fails.
 *  - `ranked-merge`: wait for every child, never throws, and orders `results`
 *    with the caller-provided `rank` comparator.
 */
export type FanoutStrategy =
  | 'wait-all'
  | 'fail-fast'
  | 'best-effort'
  | 'quorum'
  | 'first-success'
  | 'ranked-merge'

/** One fanout child when targets are heterogeneous (`items` form). */
export interface FanoutChildSpec {
  readonly pipelineId: string
  readonly input?: unknown
}

export interface WorkflowFanoutOptions {
  /** Single target pipeline run once per entry in `inputs`. Mutually exclusive with `items`. */
  readonly pipelineId?: string
  /** Inputs for the `pipelineId` form; one child per entry. */
  readonly inputs?: readonly unknown[]
  /** Heterogeneous child specs. Mutually exclusive with `pipelineId`/`inputs`. */
  readonly items?: readonly FanoutChildSpec[]
  /** Defaults to `wait-all`. */
  readonly strategy?: FanoutStrategy
  /** Max children in flight at once. Defaults to 4; capped at 16. */
  readonly concurrency?: number
  /** `wait-all` only: collect failures into the result instead of throwing. */
  readonly continueOnError?: boolean
  /** Required for `quorum`: number of completed children that resolves the fanout. */
  readonly quorum?: number
  /** Required for `ranked-merge`: comparator ordering the merged `results`. */
  readonly rank?: (a: WorkflowInvokeResult, b: WorkflowInvokeResult) => number
  /** Optional narrower ceiling applied to every child (narrowing only). */
  readonly ceiling?: AgentPermissions
}

export interface WorkflowFanoutResult<TOutput = unknown> {
  /** `completed` when the strategy's success condition was met by every counted child. */
  readonly status: 'completed' | 'failed'
  /**
   * Per-child results, index-aligned with the child list (`undefined` for
   * children cancelled before they started). For `ranked-merge` the settled
   * results are instead ordered by the `rank` comparator.
   */
  readonly results: readonly (WorkflowInvokeResult<TOutput> | undefined)[]
  readonly successes: readonly WorkflowInvokeResult<TOutput>[]
  readonly failures: readonly WorkflowInvokeResult<TOutput>[]
}

/** In-workflow orchestration of child workflows, bounded by the step's policy. */
export interface WorkflowsHandle {
  /** Run a child workflow to a terminal state and return its result envelope. */
  invoke<TOutput = unknown>(opts: WorkflowInvokeOptions): Promise<WorkflowInvokeResult<TOutput>>
  /** Run many children with bounded concurrency and merge per `strategy`. */
  fanout<TOutput = unknown>(opts: WorkflowFanoutOptions): Promise<WorkflowFanoutResult<TOutput>>
}

export interface TaskSpawnOptions {
  /** Id of the registered workflow to run, resolved via the pipeline registry. */
  readonly workflowId: string
  readonly input?: unknown
  readonly deliveryTarget?: DeliveryTarget
  /** Optional narrower ceiling for the detached child (narrowing only). */
  readonly ceiling?: AgentPermissions
}

/** Correlation handle returned by `ctx.tasks.spawn`. */
export interface SpawnedTaskHandle {
  readonly taskId: string
  readonly childRunId: string
}

/**
 * Detached-task orchestration. A spawned task records a Phase-2 `TaskRecord`
 * with `parentRunId`/`parentStepId` lineage and runs the child detached from
 * the parent step's lifetime — but still under the parent's permission
 * ceiling. Detachment is not a permission escape hatch.
 */
export interface TasksHandle {
  spawn(opts: TaskSpawnOptions): Promise<SpawnedTaskHandle>
  /** Resolve once the task reaches a terminal status; returns the final record. */
  wait(taskId: string): Promise<TaskRecord>
  /** Cancel a task spawned by this step (aborts its child run). */
  cancel(taskId: string): Promise<void>
  /** Subscribe to the spawned child run's live events; returns unsubscribe. */
  stream(taskId: string, onEvent: (event: RunEvent) => void): () => void
}
