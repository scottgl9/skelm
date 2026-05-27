# Permissions and the trust boundary

skelm enforces permissions at one place: the gateway. Every privileged action — tool call, exec, fs read/write, network egress, secret resolution, approval — flows through gateway-owned enforcers. Backends never bypass them.

## The four seams

```
PermissionResolver  →  resolves the effective policy from defaults + step + profile + overrides
TrustEnforcer       →  evaluates each privileged action against a resolved policy (canCallTool, ...)
SecretResolver      →  fetches secrets by name; logs the fact of access, never the value
ApprovalGate        →  suspends runs that hit `permissions.approval` until a human responds
AuditWriter         →  single-writer append-only chain (Phase 5) recording every decision
```

These types live in `@skelm/core/enforcement/*` and are exported from the package root. The `Runner` constructor accepts each as an injection point with safe in-process defaults so unit tests stay self-contained:

```ts
const runner = new Runner({
  // …existing options…
  auditWriter:    new NoopAuditWriter(),    // default
  secretResolver: new EnvSecretResolver(),  // default — reads process.env
  approvalGate:   new AutoApproveGate(),    // default
})
runner.enforcement // canonical instances actually in use
```

In production the **gateway** owns the canonical instances and hands them to every Runner it constructs (Phase 11). `gateway.enforcement` exposes them after `start()` and throws after `stop()`. Rebuilding via `gateway.reload({ defaults: { permissions: ... } })` is allowed and atomic.

## Default-deny is structural

`AgentPermissions` fields default to `undefined`, which the runtime treats as deny. The enforcement seams above never widen — only narrow. Adding a new permission dimension keeps these guarantees:

1. The new field is optional and defaults to `undefined`.
2. The runtime treats `undefined` as deny.
3. An adversarial fixture under `packages/core/test/security/` proves the deny path fires.
4. The dimension is documented here.

Beyond the core dimensions (tools, executables, MCP servers, skills, secrets, network, filesystem, approval), the `agentmemory` dimension gates the optional [agentmemory integration](/guides/agentmemory) per operation — `observe`/`search`/`session`/`context`/`save`/`recall`/`graph`, or the `'deny'` shorthand. It follows every rule above: omitted ⇒ deny (proven by `packages/core/test/security/agentmemory-default-deny.test.ts`), intersection-only composition, and the gateway hands a step no memory handle at all unless its policy grants an op.

## Where each piece lives today

| Concern | Phase | Status |
|---------|-------|--------|
| `PermissionResolver`, `TrustEnforcer` | 4 | Wired; in-process defaults match production behavior. |
| `AuditWriter` | 5 | Seam in place; default no-op; chain writer next. |
| `SecretResolver` (env) | 4 | Wired. |
| `SecretResolver` (file driver) | 5 | Pending. |
| `ApprovalGate` (auto-approve / auto-deny) | 4 | Wired (test-friendly). |
| `ApprovalGate` (suspend + resume) | 6 | Wired. The runtime calls `runtime.approvalGate.request(...)` at the start of every agent step whose resolved policy declares `permissions.approval`. A denial fails the step with `ApprovalDeniedError`. |
