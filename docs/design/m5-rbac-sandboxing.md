# Design: M5+ — Multi-user RBAC and OS-level sandboxing

Tracking: [#36](https://github.com/scottgl9/skelm/issues/36)

## Goal

Enterprise / production posture: identify users, scope what they can do, and
isolate pipeline execution at the OS layer so a hostile or buggy pipeline
cannot reach beyond its declared permissions.

This is **post-v1, post-M4**. The current default-deny model and trust
boundary are sound for single-tenant local-first deployments; M5 is what
makes skelm safe to expose multi-user.

## Non-goals

- A managed cloud product. skelm stays self-hostable.
- Replacing the existing default-deny permission model. M5 layers on top;
  a request that is denied by default-deny is still denied even if RBAC
  would have allowed it.

## Threat model (sketch)

We will land a full threat model as a separate document under
`docs/design/threat-model.md` once Phase 1 is scoped. The headline classes
of risk M5 must address:

| Class                      | Today                    | M5 mitigation                          |
| -------------------------- | ------------------------ | -------------------------------------- |
| Compromised user account   | All actions = root       | RBAC scopes per role + per pipeline    |
| Compromised pipeline code  | Process boundary only    | Container/sandbox per agent step       |
| Cross-tenant data leak     | Single tenant            | Per-tenant workspace + audit isolation |
| Resource exhaustion        | Best-effort              | Hard CPU/mem/network limits per step   |
| Side-channel via shared FS | Shared workspace root    | Dedicated per-step volume              |

## Phase 1 — Identity and RBAC

### Identity

- Bearer tokens (today) → continue to support.
- API keys per principal — issued via a new `skelm api-keys` subcommand.
- OAuth 2.0 / OIDC for human users; one provider for v1 (likely GitHub or
  Auth0). Provider plug-in surface so others can be added.
- SSO via SAML — explicit non-goal for v1; bridged via OIDC if needed.

### Roles

Three roles for v1, intentionally coarse:

- **admin** — every action.
- **developer** — read everything, run/start pipelines, manage own runs.
- **viewer** — read-only.

Per-pipeline scopes layer on top: a developer can be granted run rights on
some pipelines and not others.

### Acceptance

- Every audit row carries a principal (today: `actor` is a free-form string).
- Gateway routes consult an authorizer before dispatch; default-deny.
- Test matrix: for each route, prove that each role gets the expected
  status code, AND that an undeclared principal gets `401`.

### Risks

- Audit log schema bump. Once principals are mandatory, old rows must
  migrate or be tagged with a sentinel.
- Token sprawl. Document a rotation cadence and a `skelm api-keys revoke`.

## Phase 2 — OS-level sandboxing

### Options compared

| Option       | Boundary       | Cost       | Notes                                     |
| ------------ | -------------- | ---------- | ----------------------------------------- |
| Docker       | Container      | Medium     | Most portable; large surface              |
| gVisor       | User-space kernel | Higher  | Strong isolation; OS support narrow       |
| Firecracker  | Lightweight VM | High       | Cleanest; ops cost is real                |
| nsjail / bwrap | Namespaces   | Low        | Linux-only; simpler than Docker           |
| Process      | None           | Lowest     | Today; not a sandbox                      |

Likely choice for v1: **Docker** as the default with `nsjail` as a
Linux-only escape hatch for low-overhead deployments. Firecracker is
attractive but the operator complexity is too high for a first ship.

### Sandbox interface

Introduce a new SPI under `@skelm/core/sandbox`:

```ts
export interface Sandbox {
  prepare(step: AgentStep, workspace: WorkspaceConfig): Promise<SandboxHandle>
  exec(handle: SandboxHandle, request: AgentRequest, signal: AbortSignal): AsyncIterable<...>
  release(handle: SandboxHandle): Promise<void>
}
```

The runner consults the active sandbox before dispatching an agent step.
A `NoopSandbox` keeps current behavior; a `DockerSandbox` is the v1 driver.

### Resource limits

- CPU: cgroup quota per step.
- Memory: hard limit; OOM kill counts as a typed `StepResourceError`.
- Network: deny by default; allow only what `permissions.networkEgress`
  explicitly lists. The sandbox enforces this via container network policy,
  not just at the runtime layer.
- Disk: bind-mount the workspace; nothing else.

### Acceptance

- Agent steps execute inside the sandbox by default when one is configured.
- A pipeline that exceeds the configured CPU/memory/network limits fails
  with a typed error and an audit row.
- Adversarial test: a malicious pipeline that attempts to read
  `/etc/passwd` outside its bind-mount fails.

## Phase 3 — Multi-tenancy

Out of scope for the first cut; the right design here depends on what the
RBAC and sandbox phases reveal. Tracking note only:

- Audit log per tenant (or a tenant_id column with row-level filtering).
- Workspace root per tenant.
- Token quota per tenant.

## Sequencing

1. Phase 1, Identity (foundational; everything else depends on it).
2. Phase 1, RBAC.
3. Phase 2, Sandbox SPI + Docker driver.
4. Phase 2, Resource limits.
5. Phase 3, Multi-tenancy (scope after Phases 1–2 land).

## References

- [#36](https://github.com/scottgl9/skelm/issues/36) — issue this design tracks
- M4 production drivers: [#34](https://github.com/scottgl9/skelm/issues/34)
- Current trust boundary: `docs/concepts/security.md`
