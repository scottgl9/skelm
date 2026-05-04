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

The suspend gate is owned by the gateway and exposed via `gateway.enforcement.approvalGate` (after the gate is wired into the gateway constructor in Phase 11). Persistence across gateway restarts is RunStore-backed and lands alongside the HTTP control surface.

## CLI

```bash
skelm approvals list                # pending approvals queued by the running gateway
skelm approvals approve <id>        # (Phase 11 — needs HTTP control surface)
skelm approvals deny    <id> --reason "too risky"
```

`<id>` is `<runId>:<stepId>`; the `list` output reads the gateway's queue snapshot from `~/.skelm/approvals.json`. `approve` and `deny` reach the gateway over HTTP once Phase 11 lands the control surface.

## Audit trail

Every approval request and resolution is appended to the audit chain:

```
approval.request   { runId, stepId, action, contextHash }
approval.approve   { id, approver, reason? }
approval.deny      { id, approver, reason? }
```

The contextHash is a SHA-256 of the request context so the audit reader can confirm which payload the human saw without storing the raw payload.

## Status

Phase 6 lands the `SuspendApprovalGate` and CLI shell. Phase 11 wires the HTTP `POST /runs/:runId/approve` and `POST /runs/:runId/deny` endpoints, plus the JSON queue snapshot the CLI consumes today.
