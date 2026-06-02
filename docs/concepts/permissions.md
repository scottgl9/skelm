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

### Per-workflow project ceilings

`skelm run <dir>` activation pins the project's `defaults.permissions` and `defaults.permissionProfiles` to **just that project's workflows**. The gateway stores them keyed by workflow id and consults them — before the operator-wide `config.defaults.permissions` — whenever a run of that workflow starts (persistent turn, queue/cron-dispatched pipeline, or HTTP `POST /pipelines/:id/run`). The fallback chain is:

```
step.permissions  ∩  (per-workflow project ceiling || operator-wide ceiling || none)  ∩  delegation ceiling
```

Two consequences worth knowing:

1. **No cross-contamination across projects.** If project A activates with `defaults.permissions.networkEgress: { allowHosts: ['a.example'] }` and project B activates with `'allow'`, project B's workflows still resolve to `'allow'`. A's narrower ceiling does not silently bind B's runs.
2. **A workflow whose project's `skelm.config.*` declares no `defaults.permissions` falls back to the gateway's operator-wide defaults.** With neither set, the agent's own declared `permissions` are the only ceiling, intersected only with `delegation` upstream — i.e. there is no extra narrowing, not a deny-all. (The framework's typed deny-all baseline in `DEFAULT_CONFIG` is never propagated as an operator ceiling — see `loadSkelmConfig` and the `Gateway` constructor.)

The same per-workflow scoping applies to `config.backends.{agent,infer}`: an `agent()` step with no explicit `backend:` resolves to its **project's** default backend before falling through to "first registered with `run()`". This is what lets a project's `skelm.config.mts` be the authoritative source for the workflow's backend choice, model selection (carried on the registered backend instance), and permission ceiling — without one project's config silently overriding another's on a shared gateway.

## Default-deny is structural

`AgentPermissions` fields default to `undefined`, which the runtime treats as deny. The enforcement seams above never widen — only narrow. Adding a new permission dimension keeps these guarantees:

1. The new field is optional and defaults to `undefined`.
2. The runtime treats `undefined` as deny.
3. An adversarial fixture under `packages/core/test/security/` proves the deny path fires.
4. The dimension is documented here.

Beyond the core dimensions (tools, executables, MCP servers, skills, secrets, network, filesystem, approval), the `agentmemory` dimension gates the optional [agentmemory integration](/guides/agentmemory) per operation — `observe`/`search`/`session`/`context`/`save`/`recall`/`graph`, or the `'deny'` shorthand. It follows every rule above: omitted ⇒ deny (proven by `packages/core/test/security/agentmemory-default-deny.test.ts`), intersection-only composition, and the gateway hands a step no memory handle at all unless its policy grants an op.

The `delegation` dimension gates agent-to-agent [delegation](/concepts/delegation): which agents/pipelines an agent may hand off to via the `delegate` tool. It is matched like `allowedTools` (exact ids, `foo.*` prefixes, or `*`) and follows every rule above — omitted ⇒ deny (proven by `packages/core/test/security/delegation-default-deny.test.ts`), intersection-only composition. Critically, a delegated child's *entire* resolved policy is intersected with the delegating agent's, so delegation can only ever narrow authority down the chain. See [Delegation](/concepts/delegation).

### Executable patterns

`allowedExecutables` accepts two entry kinds. A plain binary — `node`,
`/usr/bin/git` — matches that binary with **any arguments** (a path-bearing
binary must be listed by its exact path; there is no basename fallback). An entry
containing a `*` or whitespace is a **command-line glob** matched against the full
command line: `node *` allows node with any arguments, `node build*` allows only
commands starting with `node build`. This applies to both `ctx.exec` and exec/shell
MCP tools. Glob matching is a coarse string check, **not shell-aware** — it bounds
which command shapes may run, not their runtime effects, so it does not prevent
argument or shell injection inside a matched command.

### MCP filesystem & exec enforcement is best-effort

For MCP tool calls, the gateway enforces the `executable` and `fs.read`/`fs.write`
dimensions by inspecting the call's arguments. Recognised filesystem/shell tool
names are classified precisely; a tool with an **unrecognised** name is treated
fail-closed — any path-shaped argument it carries is checked as a **write** (so an
unknown tool cannot read or write outside `fsWrite`), and an `argv` array is
checked against `allowedExecutables`. This cannot be complete: a tool can still
act on a path hardcoded server-side, or passed under an argument name skelm does
not recognise, and a bare `command` string on an unknown tool is not auto-detected
(it is too ambiguous to gate reliably). **Treat the MCP servers you attach as part
of your trust boundary** — scope `allowedTools` tightly and only attach servers you
trust. The `tool` dimension (`canCallTool`) is always enforced and is the primary
gate; the fs/exec checks are defense-in-depth on top of it.

## The unrestricted bypass (freewheeling agents)

Some use cases — a personal chat assistant you talk to over Telegram, a [persistent workflow](/concepts/persistent-workflows) behaving like a freewheeling shell — want a full bypass of default-deny rather than an exhaustive allow-list. skelm supports this **only as an explicit, operator-gated, audited opt-in**. It never weakens default-deny for anything that does not opt in.

The bypass is **two-keyed** — both keys are required, and they live on opposite sides of the trust boundary:

1. **Author request** (untrusted): the agent declares `permissions.requestUnrestricted: true`. On its own this flag does **nothing** — it cannot widen a single allow-list. A pipeline therefore cannot self-escalate.
2. **Operator grant** (trusted): the gateway operator lists the workflow / persistent-workflow id in `defaults.unrestrictedGrants` (or the env var `SKELM_UNRESTRICTED_WORKFLOWS`, comma-separated). The gateway passes this grant into `resolvePermissions(..., { grantUnrestricted: true })`; authors can never set it.

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
