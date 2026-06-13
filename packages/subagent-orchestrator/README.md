# @skelm/subagent-orchestrator

Reusable subagent-orchestration workflows and helpers for skelm. Fan child
agent / research / review tasks out with a chosen merge strategy and bounded
concurrency, enforce per-child agent-harness budgets, preserve parent → child
lineage, stream partials, and merge typed results.

Everything here **composes** the merged orchestration primitives in
[`@skelm/core`](../core) — `ctx.workflows.fanout`, `ctx.workflows.invoke`, and
`ctx.tasks.spawn/wait/cancel/stream`. It does **not** reimplement the
orchestration runtime or the permission math.

## Children are permission-ceiling-bound by the parent

Every child started through these helpers runs under the **delegation
ceiling**: the calling `code()` step's resolved policy is the child's ceiling,
and any policy the child resolves for itself is intersected with it. A child
can *declare* more than its parent — it only ever *gets* the intersection.
These helpers **cannot widen** the ceiling; the optional `ceiling` option can
only narrow further.

Starting a child at all is **default-deny**: the orchestrating step must grant
each target id through its `permissions.delegation` allowlist, exactly like raw
`ctx.workflows`/`ctx.tasks`.

## Helpers

| Export | Composes | Purpose |
|---|---|---|
| `fanOut(ctx, opts)` | `ctx.workflows.fanout` | Run N child tasks with a strategy + bounded concurrency; returns the typed merged envelope plus lineage. |
| `rankedMerge(ctx, tasks, rank, opts?)` | `fanout` (`ranked-merge`) | Fan out and order the settled results by a caller-supplied comparator. |
| `quorum(ctx, tasks, threshold, opts?)` | `fanout` (`quorum`) | Resolve once `threshold` children complete; cancel the rest. |
| `runSubagents(ctx, opts)` | `fanOut` | Research/coding/review recipe: threads a `SubagentInput` envelope (role + parent lineage + per-child `AgentBudget`) into each child. |
| `retrySubagents(ctx, opts, retry)` | `runSubagents` | Re-run a selected subset of subagent specs with the same configuration. |
| `spawnSubagent(ctx, role, spec)` | `ctx.tasks.spawn/wait/cancel/stream` | Spawn one detached, streamable, abortable subagent. |

### `fanOut`

```ts
import { fanOut } from '@skelm/subagent-orchestrator'

const merged = await fanOut<ScanResult>(ctx, {
  tasks: [
    { workflowId: 'scan', input: reportA },
    { workflowId: 'scan', input: reportB },
  ],
  strategy: 'best-effort', // wait-all | fail-fast | best-effort | quorum | first-success | ranked-merge
  concurrency: 4,          // forwarded to the core fanout, capped at 16
})
// { status, results, successes, failures, parentRunId, lineage }
```

### Research / coding / review recipe with budgets

`runSubagents` threads a typed `SubagentInput` envelope into each child:

```ts
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

Each child receives `{ role, parentRunId, payload, budget }`. The per-child
`budget` is an `@skelm/agent` `AgentBudget` — a **safety limit** (token / cost /
tool-call / wall-clock), not a permission. The child's `agent()` step applies
it via the agent harness; this package only forwards it.

### Detached, streamable subagents

```ts
const sub = await spawnSubagent(ctx, 'coding', { workflowId: 'implementer', input })
const off = sub.stream((e) => console.log(e.type)) // live partials
const record = await sub.wait()                     // terminal status
off()
// or: await sub.abort()
```

`spawnSubagent` requires a task-capable run store (always present for
gateway-hosted runs; pass `store` to `runPipeline` for programmatic runs).
The detached child is still ceiling-bound — detachment is not a permission
escape hatch.

## Lineage

`FanOutResult` carries `parentRunId` and a `lineage[]` of
`{ workflowId, runId, status }` per settled child, so callers can reconstruct
the parent → child tree without unpacking each envelope.

## See also

- [Workflow orchestration](https://skelm.dev/concepts/orchestration) — the
  underlying `ctx.workflows` / `ctx.tasks` primitives and their security model.
- [Subagent orchestration](https://skelm.dev/recipes/subagent-orchestration) —
  the recipe page for this package.
