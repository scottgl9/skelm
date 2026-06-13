// Parameterized research / coding / review subagent recipe. Spawns child
// agents through `ctx.workflows.fanout`, threads a typed `SubagentInput`
// envelope (role + parent lineage + optional per-child agent-harness budget)
// to each child, and returns the merged envelope with lineage. Budgets are a
// SAFETY LIMIT applied by the child's agent harness, never a permission; this
// recipe only forwards them. Children stay ceiling-bound by the calling step.

import type { Context, RunEvent, SpawnedTaskHandle } from '@skelm/core'
import { TaskOrchestrationError } from '@skelm/core'
import { fanOut } from './fanout.js'
import type {
  FanOutResult,
  RunSubagentsOptions,
  SubagentInput,
  SubagentSpec,
  SubagentTask,
} from './types.js'

function toChildInput<TInput>(
  spec: SubagentSpec<TInput>,
  role: RunSubagentsOptions<TInput>['role'],
  parentRunId: string,
  defaultBudget: RunSubagentsOptions<TInput>['defaultBudget'],
): SubagentInput<TInput> {
  const budget = spec.budget ?? defaultBudget
  return {
    role,
    parentRunId,
    ...(spec.input !== undefined && { payload: spec.input }),
    ...(budget !== undefined && { budget }),
  }
}

/**
 * Run a fleet of research/coding/review subagents. Each child receives a
 * {@link SubagentInput} envelope carrying the role, parent run id (lineage),
 * and its per-child budget; the child's agent step reads `budget` to bound its
 * loop. Composes {@link fanOut} (and thus `ctx.workflows.fanout`) so every
 * child remains permission-ceiling-bound by the calling step.
 */
export function runSubagents<TInput = unknown, TOutput = unknown>(
  ctx: Context,
  opts: RunSubagentsOptions<TInput, TOutput>,
): Promise<FanOutResult<TOutput>> {
  const tasks: SubagentTask<SubagentInput<TInput>>[] = opts.children.map((spec) => ({
    workflowId: spec.workflowId,
    input: toChildInput(spec, opts.role, ctx.run.runId, opts.defaultBudget),
  }))
  return fanOut<TOutput>(ctx, {
    tasks,
    ...(opts.strategy !== undefined && { strategy: opts.strategy }),
    ...(opts.concurrency !== undefined && { concurrency: opts.concurrency }),
    ...(opts.continueOnError !== undefined && { continueOnError: opts.continueOnError }),
    ...(opts.quorum !== undefined && { quorum: opts.quorum }),
    ...(opts.rank !== undefined && { rank: opts.rank }),
    ...(opts.ceiling !== undefined && { ceiling: opts.ceiling }),
  })
}

/**
 * Re-run a subset of subagent specs (typically the ones whose prior run did not
 * complete) with the same role/strategy/budget configuration. A caller drives
 * a retry loop by selecting the specs to retry from the prior result's
 * `lineage` and passing them here. Returns the merged envelope of the retried
 * children only.
 */
export function retrySubagents<TInput = unknown, TOutput = unknown>(
  ctx: Context,
  opts: Omit<RunSubagentsOptions<TInput, TOutput>, 'children'>,
  retry: readonly SubagentSpec<TInput>[],
): Promise<FanOutResult<TOutput>> {
  if (retry.length === 0) {
    throw new TaskOrchestrationError('retrySubagents: no children to retry')
  }
  return runSubagents<TInput, TOutput>(ctx, { ...opts, children: retry })
}

/** Handle for a streamed, abortable detached subagent. */
export interface DetachedSubagent {
  readonly handle: SpawnedTaskHandle
  /** Resolve at the child's terminal status; returns the final task record. */
  readonly wait: () => Promise<Awaited<ReturnType<NonNullable<Context['tasks']>['wait']>>>
  /** Abort the detached child run. */
  readonly abort: () => Promise<void>
  /** Subscribe to the child run's live events for streaming partials. */
  readonly stream: (onEvent: (event: RunEvent) => void) => () => void
}

/**
 * Spawn a single detached subagent and return a streamable, abortable handle.
 * Composes `ctx.tasks.spawn` / `wait` / `cancel` / `stream`. The detached child
 * is still ceiling-bound by the calling step — detachment is not a permission
 * escape hatch. Requires a task-capable run store (gateway-hosted, or pass
 * `store` to `runPipeline`).
 */
export async function spawnSubagent<TInput = unknown>(
  ctx: Context,
  role: RunSubagentsOptions<TInput>['role'],
  spec: SubagentSpec<TInput>,
): Promise<DetachedSubagent> {
  if (ctx.tasks === undefined) {
    throw new TaskOrchestrationError(
      'spawnSubagent requires ctx.tasks; run under a runtime with a task-capable run store',
    )
  }
  const tasks = ctx.tasks
  const handle = await tasks.spawn({
    workflowId: spec.workflowId,
    input: toChildInput(spec, role, ctx.run.runId, undefined),
  })
  return {
    handle,
    wait: () => tasks.wait(handle.taskId),
    abort: () => tasks.cancel(handle.taskId),
    stream: (onEvent) => tasks.stream(handle.taskId, onEvent),
  }
}
