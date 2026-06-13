/**
 * Postgres workflow actions: query, execute, transaction.
 *
 * PARAMETERIZED-ONLY: every action takes `{ text, params }`. `params` are bound
 * positionally by the driver; the package never interpolates them into `text`.
 * {@link validateStatement} rejects shapes that suggest someone is trying to
 * route a value through `text` instead of `params`, but the core guarantee is
 * structural — there is no code path that string-concatenates a param into SQL.
 */

import { PostgresValidationError } from './errors.js'
import { redactStatement } from './redaction.js'
import type { ExecutorProvider, PostgresResult, PostgresRow, PostgresStatement } from './types.js'

/**
 * Validate a statement against the parameterized-only contract. Throws
 * {@link PostgresValidationError} on:
 * - empty/whitespace `text`,
 * - `params` that is present but not an array,
 * - a placeholder reference (`$N`) with no params supplied.
 *
 * It deliberately does NOT try to parse SQL or block string literals — values
 * are made safe by binding, not by inspecting `text`.
 */
export function validateStatement(statement: PostgresStatement): void {
  if (typeof statement.text !== 'string' || statement.text.trim().length === 0) {
    throw new PostgresValidationError('statement text must be a non-empty string')
  }
  if (statement.params !== undefined && !Array.isArray(statement.params)) {
    throw new PostgresValidationError('statement params must be an array when present')
  }
  const usesPlaceholder = /\$\d+/.test(statement.text)
  const paramCount = statement.params?.length ?? 0
  if (usesPlaceholder && paramCount === 0) {
    throw new PostgresValidationError(
      'statement references positional placeholders ($N) but supplied no params',
    )
  }
}

/** Audit-safe summary of an executed statement: shape only, never values. */
export interface PostgresAuditRecord {
  readonly action: 'query' | 'execute' | 'transaction'
  /** Redacted statement(s): text preserved, param values masked. */
  readonly statements: readonly { readonly text: string; readonly paramCount: number }[]
  readonly rowCount: number
}

/**
 * `query`: run a parameterized read and return rows. The verb is conventional —
 * the database enforces nothing here; callers use `query` for reads and
 * `execute` for writes for audit clarity. Returns the rows and a redacted audit
 * record.
 */
export async function query<TRow extends PostgresRow = PostgresRow>(
  provider: ExecutorProvider,
  statement: PostgresStatement,
): Promise<{ rows: readonly TRow[]; audit: PostgresAuditRecord }> {
  validateStatement(statement)
  const { executor, release } = await provider.acquire()
  try {
    const result = await executor.query<TRow>(statement)
    return {
      rows: result.rows,
      audit: {
        action: 'query',
        statements: [redactStatement(statement)],
        rowCount: result.rowCount,
      },
    }
  } finally {
    await release()
  }
}

/**
 * `execute`: run a parameterized write (INSERT/UPDATE/DELETE) and return the
 * affected row count plus a redacted audit record.
 */
export async function execute(
  provider: ExecutorProvider,
  statement: PostgresStatement,
): Promise<{ rowCount: number; audit: PostgresAuditRecord }> {
  validateStatement(statement)
  const { executor, release } = await provider.acquire()
  try {
    const result = await executor.query(statement)
    return {
      rowCount: result.rowCount,
      audit: {
        action: 'execute',
        statements: [redactStatement(statement)],
        rowCount: result.rowCount,
      },
    }
  } finally {
    await release()
  }
}

/**
 * `transaction`: run a sequence of parameterized statements atomically on one
 * connection. Issues BEGIN, runs each statement in order, then COMMIT; ROLLBACK
 * on any error. Returns each statement's result and a redacted audit record.
 */
export async function transaction(
  provider: ExecutorProvider,
  statements: readonly PostgresStatement[],
): Promise<{ results: readonly PostgresResult[]; audit: PostgresAuditRecord }> {
  if (statements.length === 0) {
    throw new PostgresValidationError('transaction requires at least one statement')
  }
  for (const statement of statements) validateStatement(statement)

  const { executor, release } = await provider.acquire()
  try {
    await executor.query({ text: 'BEGIN' })
    const results: PostgresResult[] = []
    try {
      for (const statement of statements) {
        results.push(await executor.query(statement))
      }
      await executor.query({ text: 'COMMIT' })
    } catch (error) {
      await executor.query({ text: 'ROLLBACK' })
      throw error
    }
    const totalRows = results.reduce((sum, r) => sum + r.rowCount, 0)
    return {
      results,
      audit: {
        action: 'transaction',
        statements: statements.map(redactStatement),
        rowCount: totalRows,
      },
    }
  } finally {
    await release()
  }
}
