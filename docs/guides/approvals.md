# Approvals

Some actions are too risky to fire automatically. When a step declares `permissions.approval`, the gateway suspends the run, queues an approval request, and waits — indefinitely by default — until a human responds. While suspended, the run is durable: no resources are consumed by the step itself.

## Authoring

```ts
agent({
  id: 'destructive',
  backend: 'opencode',
  permissions: {
    approval: { for: ['fs.write', 'tool.exec'] },
  },
})
```

When the agent attempts a matching action, the runtime calls `gateway.enforcement.approvalGate.request({...})`. The promise resolves with `{ approved, approver?, reason? }`.

## Gate implementations

| Gate | When | Behavior |
|------|------|----------|
| `AutoApproveGate` | default outside the gateway, unit tests | Always approves. |
| `AutoDenyGate` | adversarial tests | Always denies. |
| `SuspendApprovalGate` | gateway production default | Suspends until `approve()`/`deny()` is called externally. |

The suspend gate is owned by the gateway and exposed via `gateway.enforcement.approvalGate`. Persistence across gateway restarts is RunStore-backed and available through the HTTP control surface.

## CLI

```bash
skelm approvals list                # pending approvals queued by the running gateway
skelm approvals approve <id>
skelm approvals deny    <id> --reason "too risky"
```

`<id>` is `<runId>:<stepId>`; the `list` output reads the gateway's queue snapshot from `~/.skelm/approvals.json`. `approve` and `deny` reach the gateway over HTTP.

## Audit trail

`SuspendApprovalGate` records every approval lifecycle transition to the gateway audit chain when constructed with an `auditWriter` (wired automatically when the gateway builds the default gate):

```
approval.requested  actor=gateway              details={ approvalId, stepId, requestedAction, context }
approval.resolved   actor=<approver|"unknown"> details={ approvalId, stepId, requestedAction, approved, reason? }
approval.expired    actor=gateway              details={ approvalId, stepId, requestedAction, timeoutMs }
approval.cancelled  actor=gateway              details={ approvalId, stepId, requestedAction, reason }
```

A single `approval.resolved` entry covers both approve and deny — `approved: true|false` carries the decision, and the approver identity becomes the audit `actor`. Decisions survive gateway restart because the chain writer is append-only and tamper-evident; audit-write failures never block the approval flow.

## Status

`SuspendApprovalGate`, the approval CLI, the HTTP `POST /runs/:runId/approve` and `POST /runs/:runId/deny` endpoints, and the JSON queue snapshot are wired.
