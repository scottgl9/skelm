/**
 * Connection model and Pool-at-dispatch executor.
 *
 * SECURITY INVARIANT: this package holds credential REFERENCES only. The pg
 * `Pool` is constructed at dispatch from values the gateway has already resolved
 * and handed in ({@link ResolvedPostgresConnection}). The package never reads
 * `process.env`, never stores the connection string / password, and ends the
 * Pool when the operation completes.
 */

import { Pool, type PoolClient } from 'pg'

import type { CredentialReference } from '@skelm/integration-sdk'
import { assertNoSecretValue } from '@skelm/integration-sdk'

import { PostgresConnectionError, PostgresQueryError } from './errors.js'
import type {
  ExecutorProvider,
  PostgresConnection,
  PostgresConnectionInput,
  PostgresResult,
  PostgresRow,
  PostgresStatement,
  QueryExecutor,
  ResolvedPostgresConnection,
} from './types.js'

/** The credential-set id this integration declares. */
export const POSTGRES_CREDENTIAL_SCHEMA_ID = 'postgres'

/**
 * Build a {@link PostgresConnection} from credential references. Throws if any
 * reference smuggles a resolved value (defense at the boundary; the
 * `CredentialReference` type already forbids it at compile time).
 */
export function definePostgresConnection(input: PostgresConnectionInput): PostgresConnection {
  for (const ref of input.credentials) {
    assertNoSecretValue(ref, 'postgres credential reference')
  }
  return {
    id: input.id,
    integrationId: 'postgres',
    credentialSchemaId: input.credentialSchemaId ?? POSTGRES_CREDENTIAL_SCHEMA_ID,
    credentials: input.credentials,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
}

/** The credential-set field names this integration recognizes. */
export type PostgresCredentialField =
  | 'connectionString'
  | 'host'
  | 'port'
  | 'database'
  | 'user'
  | 'password'

function poolConfigFor(resolved: ResolvedPostgresConnection): {
  connectionString?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
} {
  const hasDiscrete =
    resolved.host !== undefined ||
    resolved.database !== undefined ||
    resolved.user !== undefined ||
    resolved.password !== undefined ||
    resolved.port !== undefined
  if (resolved.connectionString === undefined && !hasDiscrete) {
    throw new PostgresConnectionError(
      'resolved connection has neither a connectionString nor discrete fields',
    )
  }
  return {
    ...(resolved.connectionString !== undefined && {
      connectionString: resolved.connectionString,
    }),
    ...(resolved.host !== undefined && { host: resolved.host }),
    ...(resolved.port !== undefined && { port: resolved.port }),
    ...(resolved.database !== undefined && { database: resolved.database }),
    ...(resolved.user !== undefined && { user: resolved.user }),
    ...(resolved.password !== undefined && { password: resolved.password }),
  }
}

/** Wraps a `pg.PoolClient` as a {@link QueryExecutor}. */
function clientExecutor(client: PoolClient): QueryExecutor {
  return {
    async query<TRow extends PostgresRow = PostgresRow>(
      statement: PostgresStatement,
    ): Promise<PostgresResult<TRow>> {
      try {
        const result = await client.query<TRow>(
          statement.text,
          statement.params === undefined ? undefined : [...statement.params],
        )
        return { rows: result.rows, rowCount: result.rowCount ?? 0 }
      } catch (error) {
        throw new PostgresQueryError(
          error instanceof Error ? error.message : 'postgres query failed',
        )
      }
    },
  }
}

/**
 * Build an {@link ExecutorProvider} that constructs a pg `Pool` at dispatch from
 * gateway-resolved values and ends it after the operation. The resolved values
 * stay local to this call; nothing is persisted on the package.
 */
export function poolExecutorProvider(resolved: ResolvedPostgresConnection): ExecutorProvider {
  const config = poolConfigFor(resolved)
  return {
    async acquire() {
      let pool: Pool
      let client: PoolClient
      try {
        pool = new Pool({ ...config, max: 1 })
        client = await pool.connect()
      } catch (error) {
        throw new PostgresConnectionError(
          error instanceof Error ? error.message : 'failed to connect to postgres',
        )
      }
      return {
        executor: clientExecutor(client),
        release: async () => {
          client.release()
          await pool.end()
        },
      }
    },
  }
}

/** Re-export for callers that build references inline. */
export type { CredentialReference }
