// @skelm/subagent-orchestrator — reusable orchestration workflows and helpers
// for fanning out child agent / research / review tasks with bounded budgets,
// lineage, and typed merge. Everything here COMPOSES the merged orchestration
// primitives in @skelm/core (`ctx.workflows.fanout`, `ctx.tasks.*`); it does
// not reimplement the runtime or the permission math. Children are
// permission-ceiling-bound by the calling step — the core primitive enforces
// the intersection and these helpers can only narrow it further.

export { fanOut, quorum, rankedMerge } from './fanout.js'
export {
  type DetachedSubagent,
  retrySubagents,
  runSubagents,
  spawnSubagent,
} from './recipe.js'
export type {
  FanOutOptions,
  FanOutResult,
  RunSubagentsOptions,
  SubagentInput,
  SubagentLineage,
  SubagentRole,
  SubagentSpec,
  SubagentTask,
} from './types.js'
