# @skelm/integration-postgres

A **workflow Postgres integration** for [skelm](https://skelm.dev): parameterized
`query`, `execute`, and `transaction` actions plus a polling trigger, built on the
`@skelm/integration-sdk` primitives.

> This is a *workflow* integration for operating on **your** data. It is unrelated
> to skelm core's `PostgresRunStore`, which persists run state. The two reuse the
> same `pg` driver and `Pool` pattern but are otherwise independent.

## Security model

- **Credentials are references only.** A connection lists `CredentialReference`s
  by `secretName`; the package never reads `process.env` for secrets and never
  holds a connection string or password. The **gateway** resolves references to
  ephemeral values at dispatch.
- **Pool at dispatch.** The `pg.Pool` is constructed from the gateway-resolved
  values for a single operation and ended afterward. Nothing is persisted on the
  package.
- **Parameterized-only — injection-safe by construction.** Every action takes
  `{ text, params }`. `params` are bound positionally by the driver and are
  **never** interpolated into `text`. There is no action surface that accepts an
  interpolated string, so an injection attempt smuggled through a parameter value
  is inert — it lands as a bound value, not as SQL.
- **Audit redaction.** Audit records log only the statement *shape* (the SQL
  `text`, which holds placeholders, and the param count) — never param values and
  never the connection string.

## Connection

Build a connection from credential references (resolved by the gateway):

```ts
import { definePostgresConnection } from '@skelm/integration-postgres'

const connection = definePostgresConnection({
  id: 'app-db',
  credentials: [{ kind: 'credential-ref', secretName: 'APP_DATABASE_URL' }],
  metadata: { schema: 'public' }, // non-secret only
})
```

The gateway resolves the references and hands the package a
`ResolvedPostgresConnection` at dispatch, from which it builds the Pool:

```ts
import { poolExecutorProvider, query } from '@skelm/integration-postgres'

// resolved values are supplied by the gateway — never read here from env
const provider = poolExecutorProvider(resolved)
```

## Actions

All actions take `{ text, params }`. Use `$1, $2, …` placeholders for every value.

```ts
import { query, execute, transaction } from '@skelm/integration-postgres'

// query → rows
const { rows } = await query(provider, {
  text: 'SELECT id, email FROM users WHERE active = $1',
  params: [true],
})

// execute → rowCount (INSERT/UPDATE/DELETE)
const { rowCount } = await execute(provider, {
  text: 'UPDATE users SET name = $1 WHERE id = $2',
  params: ['Ada', 42],
})

// transaction → atomic sequence (BEGIN/COMMIT, ROLLBACK on error)
await transaction(provider, [
  { text: 'INSERT INTO accounts (owner) VALUES ($1)', params: ['ada'] },
  { text: 'INSERT INTO audit (msg) VALUES ($1)', params: ['account created'] },
])
```

Never interpolate values into `text`:

```ts
// WRONG — do not do this. Build with placeholders + params instead.
query(provider, { text: `SELECT * FROM users WHERE id = ${userId}` })

// RIGHT
query(provider, { text: 'SELECT * FROM users WHERE id = $1', params: [userId] })
```

## Polling trigger

Postgres `LISTEN/NOTIFY` needs a held connection, which is awkward under the
gateway's dispatch-time Pool model, so the default trigger polls a monotonic
cursor column. The cursor is always **bound** as a parameter, so the poll inherits
the same injection safety as the actions.

```ts
import { pollOnce } from '@skelm/integration-postgres'

let cursor: string | number | undefined
const { events, cursor: next } = await pollOnce(
  provider,
  { table: 'events', cursorColumn: 'id', batchSize: 100 },
  cursor,
)
cursor = next // persist between polls
```

Each emitted change is a normalized SDK `EventEnvelope` (`source: 'postgres'`).

Table and cursor-column names are **operator configuration**, not workflow input.
They are validated as simple SQL identifiers.

## Health

```ts
import { checkHealth } from '@skelm/integration-postgres'

const status = await checkHealth(provider) // runs SELECT 1; no secrets in detail
```

## Testing

- **Default (mock):** unit tests inject a fake `ExecutorProvider`, so no database
  is required. They cover input validation, credential-ref handling, audit
  redaction, error classification, and the injection-inertness proof.
- **Live (opt-in):** the live suite runs only when both `SKELM_LIVE_POSTGRES=1`
  and `SKELM_LIVE_POSTGRES_URL=postgres://…` are set. When either is absent the
  suite skips cleanly — default CI never needs a database.

```sh
# unit/mock (default)
pnpm --filter @skelm/integration-postgres test

# live, against a local/containerized Postgres
SKELM_LIVE_POSTGRES=1 SKELM_LIVE_POSTGRES_URL=postgres://localhost/skelm_test \
  pnpm --filter @skelm/integration-postgres test
```

## License

MIT
