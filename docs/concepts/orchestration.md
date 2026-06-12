# Workflow orchestration (`ctx.workflows`, `ctx.tasks`)

`code()` steps can orchestrate other workflows directly: run a child
synchronously, fan work out across many children, or spawn a detached task
that outlives the step. These helpers are the *workflow-level* counterpart of
[agent delegation](/concepts/delegation) — and they reuse exactly the same
security machinery.

## The security model: children are ceiling-bound by the parent

Every child started through `ctx.workflows` or `ctx.tasks` runs under the
**delegation ceiling**: the calling step's resolved permission policy is
passed down as the child run's ceiling, and every policy the child resolves
for itself is intersected with it. Allow-lists intersect, deny-lists union,
network policies narrow, and a restricted parent can never produce an
`unrestricted` child. A child can *declare* more than its parent — it only
ever *gets* the intersection.

Starting a child at all is **default-deny**. The orchestrating step must
grant the target id through its `delegation` allowlist:

```ts
code({
  id: 'orchestrate',
  permissions: {
    // Matched like allowedTools: exact ids, `team.*` prefixes, or `*`.
    delegation: ['summarize', 'scanners.*'],
  },
  run: async (ctx) => { /* ctx.workflows / ctx.tasks usable here */ },
})
```

Omitting `permissions` (or the `delegation` field) denies every
`invoke`/`fanout`/`spawn` with a `PermissionDeniedError` and an audited
`permission.denied` event. The existing delegation depth cap
(`maxDelegationDepth`, default 8) and cycle refusal apply to every child:
a workflow cannot start a child that is already on its delegation chain.

A **detached task is not an escape hatch**: a child spawned via
`ctx.tasks.spawn` outlives the parent step, but it is bounded by the same
ceiling intersection as a synchronous child.

Both handles are present when the runtime has a pipeline registry wired
(`ctx.tasks` additionally needs a task-capable run store) — always true for
gateway-hosted runs; pass `pipelineRegistry`/`store` to `runPipeline()` for
programmatic runs.

## `ctx.workflows.invoke` — run one child synchronously

```ts
const result = await ctx.workflows.invoke({
  pipelineId: 'summarize',
  input: { text },
})
// { status: 'completed' | 'failed' | 'cancelled', runId, output?, error? }
if (result.status === 'completed') use(result.output)
```

The envelope is a *result*, not an exception: a failed child comes back as
`{ status: 'failed', error }` so the parent can retry or route around it.
Caller-side refusals still throw — `PermissionDeniedError` (target not on the
allowlist), `InvokePipelineNotFoundError` (unknown id),
`DelegationDepthError` / `DelegationCycleError` (chain bounds).

An optional `ceiling` narrows the child further. It can only narrow: the
requested ceiling is resolved without operator grants and intersected with
the calling step's policy.

```ts
await ctx.workflows.invoke({
  pipelineId: 'scanners.untrusted',
  input,
  ceiling: { networkEgress: 'deny' }, // child gets parent ∩ this
})
```

## `ctx.workflows.fanout` — run many children and merge

```ts
const out = await ctx.workflows.fanout({
  pipelineId: 'scanners.report',   // one child per entry in `inputs`
  inputs: reports,
  strategy: 'best-effort',
  concurrency: 4,                  // default 4, capped at 16
})
// { status, results, successes, failures }
```

Heterogeneous targets use `items` instead:

```ts
await ctx.workflows.fanout({
  items: [
    { pipelineId: 'scanners.report', input: a },
    { pipelineId: 'scanners.binary', input: b },
  ],
})
```

| Strategy | Behavior |
| --- | --- |
| `wait-all` (default) | Wait for every child; throws `FanoutFailedError` if any did not complete, unless `continueOnError: true` (then failures are recorded in the result). |
| `fail-fast` | Reject on the first non-completed child and cancel the rest. |
| `best-effort` | Wait for every child; never throws — collect `successes`, record `failures`. |
| `quorum` | Resolve as soon as `quorum` children complete and cancel the rest; throws `FanoutFailedError` once the quorum is unreachable. |
| `first-success` | Resolve on the first completed child and cancel the rest; throws if every child fails. |
| `ranked-merge` | Wait for every child, never throws, and orders `results` with the caller-provided `rank` comparator. |

`results` is index-aligned with the child list (`undefined` for children
cancelled before they started); for `ranked-merge` it is the rank-ordered
list of settled children. Invalid combinations (no target, empty inputs,
missing `quorum`/`rank`, non-positive `concurrency`) throw
`FanoutConfigError` before any child starts. Every fanout child inherits the
same ceiling intersection as `invoke`, and a denied target aborts the whole
fanout regardless of strategy — merge strategies summarize child *run*
outcomes, never a refused start.

## `ctx.tasks` — detached tasks with lineage

`ctx.tasks.spawn` creates a [task](/reference/http) record and runs the
target workflow detached from the step's lifetime:

```ts
const { taskId, childRunId } = await ctx.tasks.spawn({
  workflowId: 'long-running-audit',
  input,
  deliveryTarget: { kind: 'slack', target: '#ops' }, // optional
})

const unsubscribe = ctx.tasks.stream(taskId, (event) => log(event.type))
const task = await ctx.tasks.wait(taskId) // resolves at a terminal status
unsubscribe()
// or: await ctx.tasks.cancel(taskId)
```

- The `TaskRecord` carries `parentRunId` / `parentStepId`, and the child run
  carries `parentRunId` / `parentStepId` / `taskId`, so lineage queries
  (`GET /v1/lineage/:runId`, `skelm tasks`) reconstruct the tree.
- `task.created` / `task.completed` / `task.failed` / `task.cancelled`
  events ride on the parent run's event bus.
- `wait` polls tasks created elsewhere too (by task id); `cancel` and
  `stream` work only for tasks this step spawned — anything else is the
  gateway tasks API's job. Misuse throws `TaskOrchestrationError`.
- The detached child still runs under the parent's permission ceiling.

## Relationship to `invoke()` steps and `delegate`

- [`invoke()` / `pipelineStep()`](/concepts/registries) compose pipelines
  *declaratively* at the step level.
- The [`delegate` tool](/concepts/delegation) lets a *model* hand off
  mid-turn.
- `ctx.workflows` / `ctx.tasks` let *code* orchestrate dynamically — loops,
  conditionals, merges — with the same non-escalation guarantee as
  delegation, because all three share one bounded-child code path.

A runnable demo lives in
[`examples/orchestration`](https://github.com/scottgl9/skelm/tree/main/examples/orchestration).
