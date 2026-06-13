/**
 * Core types for the Postgres workflow integration.
 *
 * PARAMETERIZED-ONLY CONTRACT: a {@link PostgresStatement} is `{ text, params }`.
 * `text` is the SQL with `$1, $2, …` placeholders; `params` are bound
 * positionally by the driver and are NEVER interpolated into `text`. There is no
 * action surface that accepts an interpolated string, so SQL-injection via a
 * parameter value is inert by construction.
 */

import type { Connection, CredentialReference } from '@skelm/integration-sdk'

/** A single parameterized statement. `params` are bound positionally. */
export interface PostgresStatement {
  /** SQL text with positional placeholders (`$1`, `$2`, …). Never holds param values. */
  readonly text: string
  /** Values bound to the placeholders, in order. Bound, never interpolated. */
  readonly params?: readonly unknown[]
}

/** One row returned from a query — column name to value. */
export type PostgresRow = Readonly<Record<string, unknown>>

/** Result of a single executed statement. */
export interface PostgresResult<TRow extends PostgresRow = PostgresRow> {
  readonly rows: readonly TRow[]
  /** Rows affected, when the driver reports one (INSERT/UPDATE/DELETE). */
  readonly rowCount: number
}

/**
 * The minimal query surface the integration drives. The real implementation
 * wraps a `pg.PoolClient`; tests inject a fake to prove binding semantics
 * without a database. A `QueryExecutor` represents a single connection/session,
 * so a `transaction` can issue BEGIN/COMMIT/ROLLBACK against one.
 */
export interface QueryExecutor {
  query<TRow extends PostgresRow = PostgresRow>(
    statement: PostgresStatement,
  ): Promise<PostgresResult<TRow>>
}

/**
 * Obtains a {@link QueryExecutor} for one logical operation, then releases it.
 * Built at dispatch from gateway-resolved credential values; the secret value
 * is never stored on the package. Tests inject a fake.
 */
export interface ExecutorProvider {
  /** Acquire an executor; `release` returns it to the pool. */
  acquire(): Promise<{ executor: QueryExecutor; release: () => Promise<void> }>
}

/**
 * Resolved connection values supplied by the gateway at dispatch. Exactly one of
 * `connectionString` or the discrete fields must be present. These are ephemeral
 * — the package builds a Pool from them for the call and never persists them.
 */
export interface ResolvedPostgresConnection {
  readonly connectionString?: string
  readonly host?: string
  readonly port?: number
  readonly database?: string
  readonly user?: string
  readonly password?: string
  /** Optional schema search path metadata (non-secret). */
  readonly schema?: string
}

/**
 * A credential-backed Postgres connection identity. Carries credential
 * REFERENCES only (resolved by the gateway at dispatch) plus non-secret
 * metadata. Never holds the connection string or password value.
 */
export interface PostgresConnection extends Connection {
  readonly integrationId: 'postgres'
}

/** Builder input for a {@link PostgresConnection}. */
export interface PostgresConnectionInput {
  readonly id: string
  /** Secret references that authenticate the connection. Never values. */
  readonly credentials: readonly CredentialReference[]
  readonly credentialSchemaId?: string
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}
