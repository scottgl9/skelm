# RBAC & scoped tokens

The gateway is the trust boundary: it authenticates every HTTP request before
any route handler runs. Role-based access control (RBAC) lets you issue
**scoped bearer tokens** so that not every client holds full control of the
gateway.

RBAC is **opt-in and additive**. A gateway with no issued scoped tokens behaves
exactly as it always has — the single bearer token configured via
`server.auth` / `SKELM_TOKEN` is the only credential, and it has full access.
RBAC only engages once you issue at least one scoped token.

## The legacy single token is ROOT

The bearer token you configure today (`server.auth = { mode: 'bearer' }` plus a
token from config or `SKELM_TOKEN`) is treated as **root** — the equivalent of
the `*:*` scope. It bypasses every scope check and can reach every route,
including the admin token-management routes. Nothing about it changes when you
start issuing scoped tokens; existing deployments and existing CLI usage are
unaffected.

Use the root token to bootstrap RBAC: issue scoped tokens for your other
clients, then hand each client its own narrower token.

## Scopes

A scope is a `resource:action` string. Either half may be the `*` wildcard:

- `workflow:run` — exactly one action on one resource
- `workflow:*` — every action on one resource
- `*:*` — root; everything

**Resources:** `gateway`, `project`, `workflow`, `run`, `schedule`, `trigger`,
`approval`, `secret`, `integration`, `state`, `artifact`, `audit`, `admin`,
`package`, `task`.

**Actions:** `read`, `run`, `start`, `cancel`, `resume`, `approve`, `deny`,
`edit`, `publish`, `install`, `update`, `remove`, `configure`, `rotate`,
`export`, `administer`.

Scope satisfaction is a strict superset test. There is **no implicit action
hierarchy**: holding `workflow:edit` does not grant `workflow:read`. Roles
bundle the read scope explicitly where that is intended.

## Roles

Roles are named scope bundles. A token's **effective scopes** are the union of
its roles' scopes and its own explicit scopes.

| Role             | Grants                                                        |
| ---------------- | ------------------------------------------------------------- |
| `Owner`          | `*:*` (root)                                                  |
| `Admin`          | Broad management incl. admin token routes (no `*:*` bypass)   |
| `Operator`       | Run/schedule/approval operation; reads; no secrets, no admin  |
| `Developer`      | Author + publish + run workflows and packages                 |
| `Auditor`        | Read everything **plus** `audit:export`; nothing mutating     |
| `Approver`       | Act on approval gates (`approval:approve` / `approval:deny`)  |
| `Viewer`         | Read-only                                                     |
| `ServiceAccount` | Headless trigger/run a workflow; no human-review or admin     |

## Enforcement

For each request the gateway resolves the bearer token, then:

1. If it equals the legacy root token (constant-time compare) → **root**, allowed.
2. Otherwise, if scoped tokens exist, it is resolved against the token store.
   Unknown / expired / revoked → **401**.
3. A resolved scoped token with `*:*` bypasses scope checks.
4. Exempt routes (`/health`, `/healthz`, `/readyz`, `/metrics`) are always open.
5. Every other route maps to a required `resource:action`. The token's effective
   scopes must satisfy it, else **403**.
6. A non-exempt route that is **not** in the route-scope map is **denied** to any
   non-root scoped token (default-deny).

Every `401`/`403` denial is written to the audit log (`auth.denied`) with the
token id (when known), the route, and the reason. The presented secret is never
logged or audited.

## Admin token-management routes

These require the `admin:administer` scope (the root token satisfies it).

| Method | Path                              | Description                               |
| ------ | --------------------------------- | ----------------------------------------- |
| POST   | `/v1/admin/tokens`                | Issue a token; returns the secret **once** |
| GET    | `/v1/admin/tokens`                | List token metadata (never secrets/hashes) |
| POST   | `/v1/admin/tokens/:id/revoke`     | Revoke a token                            |

### Create

```bash
curl -X POST http://127.0.0.1:14738/v1/admin/tokens \
  -H "Authorization: Bearer $SKELM_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"roles":["Operator"],"scopes":["workflow:read"],"label":"ci-runner","expiresAt":"2026-12-31T00:00:00Z"}'
```

The response contains the plaintext `secret` **exactly once** — store it now; it
is never recoverable. Tokens are hashed with scrypt and a per-token salt before
persistence, so neither the listing endpoint nor the on-disk store
(`<stateDir>/tokens.json`) ever exposes the plaintext.

```json
{
  "secret": "…one-time secret…",
  "token": {
    "id": "…",
    "roles": ["Operator"],
    "scopes": ["workflow:read"],
    "label": "ci-runner",
    "createdAt": "…",
    "expiresAt": "2026-12-31T00:00:00Z"
  }
}
```

### Revoke

```bash
curl -X POST http://127.0.0.1:14738/v1/admin/tokens/<id>/revoke \
  -H "Authorization: Bearer $SKELM_TOKEN"
```

A revoked token resolves to `401` on its next request.
