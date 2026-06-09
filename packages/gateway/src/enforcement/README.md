# Permission Enforcement Pipeline

This document describes how skelm's permission enforcement flows from
operator configuration through to individual tool or network calls inside
a running pipeline step.

---

## Overview

```
GatewayOptions
  └─ buildEnforcement()                   ← gateway/src/lifecycle/gateway.ts
        ├─ auditWriter   (ChainAuditWriter | caller-supplied | NoopAuditWriter)
        ├─ secretResolver (FileSecretResolver | EnvSecretResolver | caller-supplied)
        ├─ approvalGate  (SuspendApprovalGate | caller-supplied)
        └─ permissionResolver (PermissionResolver from @skelm/core)
              └─ resolvePermissions(defaults, step) → ResolvedPolicy
                    └─ TrustEnforcer(policy)
                          ├─ canCallTool(name)
                          ├─ canExec(name)
                          ├─ canFetch(host)
                          ├─ canRead(path) / canWrite(path)
                          ├─ canAttachMcpServer(name)
                          ├─ canLoadSkill(name)
                          ├─ canAccessSecret(name)
                          ├─ canDelegate(target)
                          └─ canUseAgentmemory(op)
```

---

## Components

### `GatewayEnforcement` (gateway-types.ts)

A plain object assembled once per gateway lifecycle (during `start()` and
again on `reload()`), containing:

| Field               | Type                | Default                                      |
|---------------------|---------------------|----------------------------------------------|
| `permissionResolver` | `PermissionResolver` | Derived from `config.defaults.permissions` + `permissionProfiles` |
| `auditWriter`       | `AuditWriter`       | `ChainAuditWriter` at `<stateDir>/audit.jsonl` |
| `secretResolver`    | `SecretResolver`    | `FileSecretResolver` if `secrets.driver = 'file'`, else `EnvSecretResolver` |
| `approvalGate`      | `ApprovalGate`      | `SuspendApprovalGate` at `<stateDir>/approvals.json` |

All four can be overridden via `GatewayOptions` for tests and embedders.

### `PermissionResolver` (@skelm/core)

Resolves a per-step effective policy from two inputs:
- **defaults** — the operator's ceiling (`config.defaults.permissions`)
- **step** — the step's declared `permissions` block

`resolvePermissions(defaults, step)` returns a `ResolvedPolicy` where every
dimension is the intersection of what the operator ceiling and the step each
allow. A field absent from `defaults` is treated as `undefined` (not restrict),
so an unconfigured operator ceiling does **not** narrow a step's request.

### `TrustEnforcer` (@skelm/core)

Consumes a `ResolvedPolicy` and exposes one `can*()` method per permission
dimension. Every method returns `{ allow: true }` or
`{ allow: false, dimension, reason }`. Default-deny is structural: all
`can*()` methods return `false` when the corresponding dimension is absent
from the resolved policy.

### Per-workflow project permissions

When `skelm run <dir>` activates a project, `ProjectActivationService` calls:
- `gateway.registerWorkflowProjectPermissions(workflowId, { defaultPermissions, permissionProfiles })`

On the next run of that workflow, `GatewayRuntime.defaultPermissionRunOptions(workflowId)`
returns the project-scoped ceiling instead of the operator-wide one. This
isolates two active projects from cross-contaminating each other's ceilings.

---

## Default-deny guarantee

Every `AgentPermissions` field is optional and defaults to `undefined`.
`resolvePermissions` treats `undefined` on both sides as "no constraint
from this source", but the TrustEnforcer treats a missing allowlist as deny.
Concretely: a step that omits `allowedTools` gets no tools, even if the
operator ceiling has `allowedTools: ['*']`.

The guard at `scripts/guards/default-deny-permissions.ts` mechanically
verifies this for every new permission dimension: it requires that the field
defaults to `undefined` in the `AgentPermissions` interface and that an
adversarial fixture under `packages/core/test/security/` proves the deny
path fires when the field is absent.

---

## Audit trail

Every permission decision that results in a privileged action is written
through the single `ChainAuditWriter`. There is exactly one audit writer per
gateway instance; backends and tool hosts receive it via `Runner` options.
Agentmemory ops write through `writeAgentmemoryAudit` in
`gateway/src/execution/gateway-runtime.ts`, which translates
`AgentmemoryAuditEvent` into the common `AuditEvent` shape.

---

## Where enforcement fires

| Dimension        | Enforced by                          | File                                      |
|------------------|--------------------------------------|-------------------------------------------|
| `tool`           | MCP host `invokeTool`                | `gateway/src/http/mcp/host.ts`            |
| `executable`     | MCP host `invokeTool`                | `gateway/src/http/mcp/host.ts`            |
| `mcp`            | `Runner` attach hook                 | `core/src/runner.ts`                      |
| `skill`          | `makeSkillLoader` via `BackendContext.loadSkill` | `core/src/runner.ts`            |
| `network`        | `createPolicyFetch` via `BackendContext.fetch` | `core/src/permissions.ts`         |
| `fs.read`        | MCP host `requestedFsPath`           | `gateway/src/http/mcp/host.ts`            |
| `fs.write`       | MCP host `requestedFsPath`           | `gateway/src/http/mcp/host.ts`            |
| `secret`         | `SecretResolver.resolve`             | `core/src/secrets.ts`                     |
| `delegation`     | `Runner` delegation guard            | `core/src/runner.ts`                      |
| `agentmemory`    | `AgentmemoryHandle` factory          | `gateway/src/execution/gateway-runtime.ts` |
