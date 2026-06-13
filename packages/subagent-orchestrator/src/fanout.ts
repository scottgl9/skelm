// Reusable subagent fan-out helpers. Every helper is a thin composition over
// the merged `ctx.workflows.fanout` primitive in @skelm/core: it forwards the
// child list, strategy, concurrency, and (narrowing-only) ceiling to the
// primitive and decorates the typed result with parent/child lineage. The
// permission ceiling, depth cap, cycle refusal, and merge math all live in the
// core primitive — this package never reimplements them and cannot widen them.

import type { Context, WorkflowFanoutResult, WorkflowInvokeResult } from '@skelm/core'
import { TaskOrchestrationError } from '@skelm/core'
import type { FanOutOptions, FanOutResult, SubagentLineage } from './types.js'

function requireWorkflows(ctx: Context): NonNullable<Context['workflows']> {
  if (ctx.workflows === undefined) {
    throw new TaskOrchestrationError(
      'subagent fan-out requires ctx.workflows; run under a runtime with a pipeline registry wired',
    )
  }
  return ctx.workflows
}

function lineageOf<TOutput>(result: WorkflowFanoutResult<TOutput>): readonly SubagentLineage[] {
  const settled = result.results.filter((r): r is WorkflowInvokeResult<TOutput> => r !== undefined)
  return settled.map((r) => ({
    workflowId: r.workflowId,
    runId: r.runId,
    status: r.status,
  }))
}

/**
 * Fan a set of subagent tasks out across `ctx.workflows.fanout` with the chosen
 * strategy and bounded concurrency, returning the typed merged envelope plus
 * the parent → child lineage tree.
 *
 * Children are permission-ceiling-bound by the calling step (the core primitive
 * enforces the intersection); the optional `ceiling` can only narrow further.
 * Starting any child is default-denied unless the step's `permissions.delegation`
 * allowlist grants the target workflow id.
 */
export async function fanOut<TOutput = unknown>(
  ctx: Context,
  opts: FanOutOptions<TOutput>,
): Promise<FanOutResult<TOutput>> {
  const workflows = requireWorkflows(ctx)
  const items = opts.tasks.map((t) => ({
    pipelineId: t.workflowId,
    ...(t.input !== undefined && { input: t.input }),
  }))
  const result = await workflows.fanout<TOutput>({
    items,
    ...(opts.strategy !== undefined && { strategy: opts.strategy }),
    ...(opts.concurrency !== undefined && { concurrency: opts.concurrency }),
    ...(opts.continueOnError !== undefined && { continueOnError: opts.continueOnError }),
    ...(opts.quorum !== undefined && { quorum: opts.quorum }),
    ...(opts.rank !== undefined && {
      rank: opts.rank as (a: WorkflowInvokeResult, b: WorkflowInvokeResult) => number,
    }),
    ...(opts.ceiling !== undefined && { ceiling: opts.ceiling }),
  })
  return {
    ...result,
    parentRunId: ctx.run.runId,
    lineage: lineageOf(result),
  }
}

/**
 * Fan out and merge with a caller-supplied rank comparator. The settled child
 * results are ordered by `rank`; failures are still reported in `failures`.
 * Composes the core `ranked-merge` fan-out strategy.
 */
export function rankedMerge<TOutput = unknown>(
  ctx: Context,
  tasks: readonly FanOutOptions<TOutput>['tasks'][number][],
  rank: (a: WorkflowInvokeResult<TOutput>, b: WorkflowInvokeResult<TOutput>) => number,
  opts: Omit<FanOutOptions<TOutput>, 'tasks' | 'strategy' | 'rank'> = {},
): Promise<FanOutResult<TOutput>> {
  return fanOut<TOutput>(ctx, { ...opts, tasks, strategy: 'ranked-merge', rank })
}

/**
 * Fan out and resolve as soon as `threshold` children complete, cancelling the
 * rest. Composes the core `quorum` fan-out strategy; throws `FanoutFailedError`
 * once the threshold becomes unreachable.
 */
export function quorum<TOutput = unknown>(
  ctx: Context,
  tasks: readonly FanOutOptions<TOutput>['tasks'][number][],
  threshold: number,
  opts: Omit<FanOutOptions<TOutput>, 'tasks' | 'strategy' | 'quorum'> = {},
): Promise<FanOutResult<TOutput>> {
  return fanOut<TOutput>(ctx, { ...opts, tasks, strategy: 'quorum', quorum: threshold })
}
