# Design: M4 — Production drivers

Tracking: [#34](https://github.com/scottgl9/skelm/issues/34)

## Goal

Promote the M4-shaped seams that currently exist as stubs into production-ready
drivers, plus the operator-facing commands needed to use them.

This is a **post-v1** initiative. The aim is to land each driver as an
isolated PR behind its existing interface — never as one giant cutover.

## Scope and slicing

| Driver / command         | State today                          | M4 target                                 | Slice                                     |
| ------------------------ | ------------------------------------ | ----------------------------------------- | ----------------------------------------- |
| Postgres `RunStore`      | Skeleton in `run-store-postgres.ts`  | Full implementation, pool, migrations    | One PR per surface area; see below        |
| Vault `SecretResolver`   | Stub                                 | HashiCorp Vault adapter; rotation hooks  | One PR (interface is small)               |
| `skelm connect`          | Not implemented                      | OAuth flows for GitHub, Slack             | One PR per provider                       |
| `skelm bundle`           | Not implemented                      | Single-file deployable artifact          | One PR for v1; one per format later       |
| Jira connector           | Type stubs in `@skelm/integrations`  | Read + write + webhook trigger            | One PR; mirror the Slack package layout   |
| IMAP connector           | Type stubs                           | Inbound trigger + send                   | One PR                                    |
| Telegram connector       | Type stubs                           | Send + webhook trigger                    | One PR                                    |

## Postgres RunStore

### Acceptance

- Implements every method of the `RunStore` interface; passes the existing
  contract suite under `packages/core/test/run-store-postgres.contract.test.ts`
  unmarked (today it is `it.skip`-gated).
- Connection pool sized via env (`SKELM_PG_POOL_MAX`), default 10.
- Migrations live alongside the driver; runtime fails to start if migrations
  have not been applied (no auto-migrate by default; `--migrate` opt-in).
- One row per run; one row per event. Indexes on `(pipeline_id, started_at)`,
  `(run_id)`, `(run_id, seq)`.
- Append-only events; no UPDATE on the event table.
- Production hardening: prepared statements, statement timeouts, retries on
  connection-level errors only.

### Open questions

- Migration tool: `node-pg-migrate` vs writing our own. Lean toward our own
  (one file, simple SQL) to keep the dependency surface small.
- `LISTEN/NOTIFY` for live event tail vs polling. Polling for v1 — `NOTIFY`
  is a follow-up.

## Vault `SecretResolver`

### Acceptance

- Implements the existing `SecretResolver` interface; passes the contract suite.
- Token auth and approle auth both supported.
- Read-only by default; `set` and `unset` require an explicit
  `--allow-write` flag so the gateway cannot accidentally provision secrets.
- Rotation: a `rotate(name)` method is **out of scope** for the first PR
  (it requires a per-engine adapter). The driver returns a typed
  `NotImplementedError` so callers can fall back.

### Open questions

- KV v1 vs v2 mounts. v2 only for the first PR; v1 if a real user asks.
- Cloud secret managers (AWS, GCP) — separate driver packages, separate PRs.

## `skelm connect <provider>`

### Acceptance

- New subcommand. Spins up a one-shot HTTP listener, opens the system browser
  to the provider's OAuth URL, captures the redirect, exchanges the code for
  a token, stores it via the secret resolver under a documented name.
- Refresh on demand from the gateway (the run-time consumer asks; the connect
  command is purely for first issuance).
- Audit-logged with `skelm.connect.start` / `skelm.connect.complete`.
- `skelm connect github`, `skelm connect slack` for v1.

### Open questions

- Where the redirect URL lives. Default `http://127.0.0.1:8765/callback` and
  document; require providers to allow that or override via flag.

## `skelm bundle <pipeline>`

### Acceptance

- Resolves all imports of the pipeline file.
- Emits a single `.js` artifact and a manifest describing required env,
  secrets, and permissions.
- Output runs as `node bundle.js` against an installed gateway.
- Excludes test deps and non-runtime tooling.

### Open questions

- Bundler: esbuild for the first cut; rollup if tree-shaking is materially
  better.
- Sourcemaps: yes, external `.js.map`. Operators will want them in incidents.

## Connectors (Jira, IMAP, Telegram)

Mirror the Slack package layout exactly:

```
packages/integrations/src/<provider>/
  index.ts            # public surface
  connector.ts        # send / receive primitives
  trigger.ts          # webhook or poll trigger
  permissions.ts      # default-deny dimensions
  README.md
  *.test.ts           # connector-contract suite
```

Each provider is one PR. Each declares its required permissions and resolves
secrets through the gateway, never via env directly.

## Sequencing

1. Postgres `RunStore` (unblocks production deployments).
2. Vault `SecretResolver` (unblocks production deployments).
3. `skelm bundle` (unblocks distribution; cheap to ship).
4. Connectors in parallel: Jira, IMAP, Telegram.
5. `skelm connect` last (smallest production gain; nicest to have).

## Out of scope

- Multi-tenant RBAC ([#36](https://github.com/scottgl9/skelm/issues/36)).
- OS-level sandboxing (also #36).
- New runtime primitives. M4 is drivers + operator UX, not core changes.
