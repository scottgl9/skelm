# Triggers

Triggers fire workflows automatically — on a schedule, when a webhook arrives, when a Matrix or Slack message lands, when a queue produces a message. The gateway hosts a `TriggerCoordinator` that maps every fire to the registered workflow and applies overlap policy.

## Trigger kinds (Phase 10)

| Kind | Notes |
|------|-------|
| `manual` | No automatic firing. The caller invokes `coordinator.fire(id)` (used by webhook receivers, Matrix/Slack pumps, manual `skelm` invocations). |
| `interval` | Fires every `everyMs` milliseconds. |
| `cron` | Currently a narrow `*/N * * * *` parser (every N minutes). Full cron parsing lands when needed. |

The richer trigger plugins under `@skelm/core/triggers` (matrix, slack, github webhooks) plug into the coordinator via the `manual` kind: each plugin owns its transport and calls `coordinator.fire(id, when)` whenever it sees an event. This keeps the coordinator narrow and lets transport plugins evolve independently.

## Overlap policy

Per-trigger policy applied when a fire arrives while a previous fire is still in flight:

| Policy | Behavior |
|--------|----------|
| `skip` (default) | New fire is dropped silently. |
| `queue` | New fire enqueues; runs in arrival order after the in-flight fire finishes. |
| `cancel` | Phase 10 treats this as `skip` — wired to true cancellation when the runner gains an external abort signal API. |

Default per-coordinator can be overridden with `defaultOverlap` at construction.

## Wiring into a workflow

```ts
const coordinator = new TriggerCoordinator({
  onFire: async ({ workflowId, firedAt, triggerId }) => {
    const reg = gateway.registries.workflows.get(workflowId)
    if (reg === undefined) return
    const { default: pipeline } = await import(reg.path)
    const runner = new Runner({
      ...gateway.enforcement,
    })
    const handle = runner.start(pipeline, { firedAt, triggerId })
    await handle.wait()
  },
})

coordinator.register({ kind: 'interval', id: 'every-5m', workflowId: 'workflows/poll.workflow.ts', everyMs: 5 * 60_000 })
```

The CLI's `skelm gateway start --foreground` wires this loop internally via
`createTriggerDispatcher({ gateway, loadWorkflow })`, where `loadWorkflow`
uses `tsx` to import the registered workflow file. Custom embeddings can do
the same with their own loader.

In Phase 11 the gateway wires this loop internally and exposes:

```bash
skelm triggers list
skelm triggers fire <id>
```

## Audit

Every fire emits:

```
trigger.fire   { triggerId, workflowId, firedAt }
trigger.skip   { triggerId, reason: 'overlap' }
trigger.error  { triggerId, message }
```

## Status

Phase 10 ships the coordinator with cron / interval / manual kinds and the three overlap policies. Phase 11 wires the coordinator into the gateway lifecycle and exposes the CLI verbs.
