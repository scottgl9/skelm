# Subagent orchestration

The [`@skelm/subagent-orchestrator`](https://www.npmjs.com/package/@skelm/subagent-orchestrator)
package provides reusable workflows and helpers for fanning child agent /
research / review tasks out with bounded budgets, lineage, and typed merge.

It is a thin composition layer over the
[workflow-orchestration primitives](/concepts/orchestration) (`ctx.workflows`,
`ctx.tasks`) — it adds recipes and ergonomics on top, and **reimplements
nothing**: the merge strategies, concurrency, depth/cycle caps, and the
permission ceiling all live in `@skelm/core`.

## Children are permission-ceiling-bound by the parent

Every child started through these helpers runs under the **delegation
ceiling**: the calling `code()` step's resolved policy becomes the child's
ceiling, and any policy the child resolves for itself is intersected with it. A
child can *declare* more than its parent — it only ever *gets* the
intersection. These helpers **cannot widen** the ceiling; the optional
`ceiling` option can only narrow it further, and a detached `spawnSubagent`
child is bounded the same way (detachment is not an escape hatch).

Starting a child is **default-deny**: the orchestrating step must grant each
target workflow id through its `permissions.delegation` allowlist. Omit it and
every fan-out/spawn is refused with a `PermissionDeniedError` and an audited
`permission.denied` event — identical to the raw primitives.

```ts
code({
  id: 'orchestrate',
  permissions: { delegation: ['researcher', 'reviewer'] }, // default-deny without this
  run: async (ctx) => { /* subagent helpers usable here */ },
})
```

## `fanOut` — many children, one merged envelope

```ts
import { fanOut } from '@skelm/subagent-orchestrator'

const merged = await fanOut<ScanResult>(ctx, {
  tasks: [
    { workflowId: 'scan', input: reportA },
    { workflowId: 'scan', input: reportB },
  ],
  strategy: 'best-effort', // wait-all | fail-fast | best-effort | quorum | first-success | ranked-merge
  concurrency: 4,          // forwarded to ctx.workflows.fanout; capped at 16
})
// { status, results, successes, failures, parentRunId, lineage }
```

`fanOut` forwards the task list, strategy, concurrency, and (narrowing-only)
`ceiling` straight to `ctx.workflows.fanout`, then decorates the result with the
parent run id and a `lineage[]` of `{ workflowId, runId, status }` per settled
child. The strategy semantics are exactly those of the core fan-out (see the
[strategy table](/concepts/orchestration#ctx-workflows-fanout-run-many-children-and-merge)):
a failing child is collected (`best-effort`) or aborts the rest (`fail-fast`),
`quorum` resolves at a threshold, and `ranked-merge` orders results by a
caller-supplied comparator.

## Ranked-merge and quorum shortcuts

```ts
import { quorum, rankedMerge } from '@skelm/subagent-orchestrator'

// Order settled results by score (composes the `ranked-merge` strategy).
const ranked = await rankedMerge<Finding>(ctx, tasks, (a, b) =>
  (b.output?.score ?? 0) - (a.output?.score ?? 0),
)

// Resolve once 3 children complete, cancel the rest (composes `quorum`).
const q = await quorum<Finding>(ctx, tasks, 3, { concurrency: 5 })
```

## The research / coding / review recipe

`runSubagents` is the parameterized recipe. It threads a typed `SubagentInput`
envelope — `{ role, parentRunId, payload, budget }` — into every child, so each
subagent knows its role and parent, and the child's `agent()` step applies its
per-child budget.

```ts
import { runSubagents } from '@skelm/subagent-orchestrator'

const merged = await runSubagents<{ prompt: string }, Finding>(ctx, {
  role: 'research',
  strategy: 'ranked-merge',
  rank: (a, b) => (b.output?.score ?? 0) - (a.output?.score ?? 0),
  defaultBudget: { tokenBudget: 50_000, maxToolCalls: 20 },
  children: [
    { workflowId: 'researcher', input: { prompt: 'sources for X' } },
    { workflowId: 'researcher', input: { prompt: 'sources for Y' }, budget: { tokenBudget: 10_000 } },
  ],
})
```

### Per-child budgets are a safety limit, not a permission

The `budget` on each spec (or the recipe's `defaultBudget`) is an
[`@skelm/agent` `AgentBudget`](/backends/skelm-agent): cumulative ceilings on tokens,
cost, tool calls, and wall-clock. When a ceiling is crossed the child's agent
loop aborts deterministically with `AgentBudgetExceededError`, after a
`run.warning`. Budgets **never widen** anything and are distinct from the
permission policy — this package only forwards them into the child input; the
agent harness enforces them.

### Retry and abort

```ts
import { retrySubagents } from '@skelm/subagent-orchestrator'

const first = await runSubagents(ctx, opts)
if (first.failures.length > 0) {
  // Re-run a selected subset with the same role/strategy/budget config.
  const retried = await retrySubagents(ctx, opts, failedSpecs)
}
```

## Detached, streamable subagents

`spawnSubagent` composes `ctx.tasks.spawn/wait/cancel/stream` for work that
should outlive the orchestrating step:

```ts
import { spawnSubagent } from '@skelm/subagent-orchestrator'

const sub = await spawnSubagent(ctx, 'coding', { workflowId: 'implementer', input })
const off = sub.stream((event) => log(event.type)) // live partials
const record = await sub.wait()                      // terminal status
off()
// or: await sub.abort()
```

It records a `TaskRecord` with `parentRunId`/`parentStepId` lineage and needs a
task-capable run store (always present for gateway-hosted runs). The detached
child is still ceiling-bound by the spawning step.

## See also

- [Workflow orchestration](/concepts/orchestration) — the underlying
  `ctx.workflows` / `ctx.tasks` primitives and their security model.
- [Workflow packages](/reference/workflow-packages) — how the package is
  installed, activated, and run.
