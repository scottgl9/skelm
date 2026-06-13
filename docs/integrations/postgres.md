---
title: Postgres Integration
---

# Postgres Integration

`@skelm/integration-postgres` is a **workflow** Postgres integration: it exposes
parameterized `query`, `execute`, and `transaction` actions plus a polling
trigger for operating on your application's data from a pipeline.

It is built on the [integration primitives](/reference/integration-primitives)
(`CredentialReference`, `Connection`, `ProviderHealthCheck`, the integration
manifest, and the SDK action/trigger helpers).

> This is distinct from skelm core's `PostgresRunStore`, which persists run
> state. Both reuse the same `pg` driver and `Pool` pattern, but the workflow
> integration operates on the operator's own database via gateway-resolved
> credential references.

## Security model

- **Credentials are references only.** Connections list `CredentialReference`s by
  `secretName`. The package never reads `process.env` for secrets and never holds
  a connection string or password — the gateway resolves references to ephemeral
  values at dispatch.
- **Pool at dispatch.** The `pg.Pool` is built from gateway-resolved values for a
  single operation and ended afterward; nothing is persisted on the package.
- **Parameterized-only.** Every action takes `{ text, params }`. `params` are
  bound positionally and never interpolated into `text`. There is no string-
  interpolation path, so SQL injection through a parameter value is inert by
  construction.
- **Audit redaction.** Audit records carry only the statement shape — the SQL
  `text` (placeholders only) and the param count — never param values and never
  the connection string. The package publishes an `AuditRedactionPolicy` naming
  `connectionString`, `password`, and `params` as redaction paths.

## Credential references

```ts
import { definePostgresConnection } from '@skelm/integration-postgres'

const connection = definePostgresConnection({
  id: 'app-db',
  credentials: [{ kind: 'credential-ref', secretName: 'APP_DATABASE_URL' }],
  metadata: { schema: 'public' }, // non-secret metadata only
})
```

The credential schema accepts either a `connectionString` field or discrete
`host`/`port`/`database`/`user`/`password` fields — all resolved by the gateway.

## Actions

| Action        | Shape                       | Returns                         |
| ------------- | --------------------------- | ------------------------------- |
| `query`       | `{ text, params }`          | `{ rows, audit }`               |
| `execute`     | `{ text, params }`          | `{ rowCount, audit }`           |
| `transaction` | `Array<{ text, params }>`   | `{ results, audit }` (atomic)   |

```ts
import { query, execute, transaction } from '@skelm/integration-postgres'

const { rows } = await query(provider, {
  text: 'SELECT id FROM users WHERE active = $1',
  params: [true],
})

const { rowCount } = await execute(provider, {
  text: 'UPDATE users SET name = $1 WHERE id = $2',
  params: ['Ada', 42],
})

await transaction(provider, [
  { text: 'INSERT INTO accounts (owner) VALUES ($1)', params: ['ada'] },
  { text: 'INSERT INTO audit (msg) VALUES ($1)', params: ['created'] },
])
```

Always use placeholders. Never build SQL by interpolating values into `text`.

## Polling trigger

`LISTEN/NOTIFY` requires a held connection, which does not fit the gateway's
dispatch-time Pool model, so the trigger polls a monotonic cursor column. The
cursor is bound as a parameter, inheriting the actions' injection safety.

```ts
import { pollOnce } from '@skelm/integration-postgres'

const { events, cursor } = await pollOnce(
  provider,
  { table: 'events', cursorColumn: 'id', batchSize: 100 },
  previousCursor,
)
```

Table and cursor-column names are operator configuration (validated as simple SQL
identifiers), not workflow input.

## Health

```ts
import { checkHealth } from '@skelm/integration-postgres'

const status = await checkHealth(provider) // SELECT 1; no secrets in detail
```

## Testing

The default test suite injects a fake executor and needs no database. A live
suite runs only when both `SKELM_LIVE_POSTGRES=1` and `SKELM_LIVE_POSTGRES_URL`
are set; otherwise it skips cleanly so default CI never requires a database.

```sh
# unit/mock (default)
pnpm --filter @skelm/integration-postgres test

# live, against a local/containerized Postgres
SKELM_LIVE_POSTGRES=1 SKELM_LIVE_POSTGRES_URL=postgres://localhost/skelm_test \
  pnpm --filter @skelm/integration-postgres test
```
