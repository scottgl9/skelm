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

## The unrestricted bypass (freewheeling agents)

Some use cases — a personal chat assistant you talk to over Telegram, a [persistent agent](/concepts/persistent-agents) behaving like a freewheeling shell — want a full bypass of default-deny rather than an exhaustive allow-list. skelm supports this **only as an explicit, operator-gated, audited opt-in**. It never weakens default-deny for anything that does not opt in.

The bypass is **two-keyed** — both keys are required, and they live on opposite sides of the trust boundary:

1. **Author request** (untrusted): the agent declares `permissions.requestUnrestricted: true`. On its own this flag does **nothing** — it cannot widen a single allow-list. A pipeline therefore cannot self-escalate.
2. **Operator grant** (trusted): the gateway operator lists the workflow / persistent-agent id in `defaults.unrestrictedGrants` (or the env var `SKELM_UNRESTRICTED_WORKFLOWS`, comma-separated). The gateway passes this grant into `resolvePermissions(..., { grantUnrestricted: true })`; authors can never set it.

```
unrestricted = operator-granted  AND  author-requested
```

Requested-but-not-granted ⇒ normal enforcement. Granted-but-not-requested ⇒ normal enforcement. Only when both agree does `TrustEnforcer` short-circuit every dimension (tools, exec, network, fs, secrets, MCP, skills, agentmemory) to allow.

The bypass is **never silent**: when a step or turn resolves to `unrestricted`, the runtime emits one `permission.bypassed` event, written through the single `AuditWriter` like every other decision. The resolved allow-lists are left exactly as intersected (the bypass is a short-circuit, not a permissive profile) so removing the grant immediately restores default-deny.

> **SECURITY.** A granted agent runs arbitrary exec / network / fs as the gateway user. Grant only ids you fully trust, and pair it with containment (workspace isolation) and an inbound allowlist on whatever drives it (e.g. a Telegram `allowedChatIds` filter — see [triggers](/guides/triggers)). Coverage: `packages/core/test/security/unrestricted-gated.test.ts` pins all four corners of the truth table.

## Where each piece lives today

| Concern | Phase | Status |
|---------|-------|--------|
| `PermissionResolver`, `TrustEnforcer` | 4 | Wired; in-process defaults match production behavior. |
| `AuditWriter` | 5 | Seam in place; default no-op; chain writer next. |
| `SecretResolver` (env) | 4 | Wired. |
| `SecretResolver` (file driver) | 5 | Pending. |
| `ApprovalGate` (auto-approve / auto-deny) | 4 | Wired (test-friendly). |
| `ApprovalGate` (suspend + resume) | 6 | Wired. The runtime calls `runtime.approvalGate.request(...)` at the start of every agent step whose resolved policy declares `permissions.approval`. A denial fails the step with `ApprovalDeniedError`. |
