/**
 * Audit redaction for the Postgres integration.
 *
 * Param values may carry secrets (a hashed password being written, a token in a
 * WHERE clause). The audit record therefore logs only the statement SHAPE — the
 * SQL `text` (which holds placeholders, never values) and the number of params —
 * never the param values themselves and never a connection string.
 */

import type { AuditRedactionPolicy } from '@skelm/integration-sdk'

import type { PostgresStatement } from './types.js'

/** Field paths the gateway must redact from audit rows for this package. */
export const POSTGRES_AUDIT_REDACTION: AuditRedactionPolicy = {
  redactPaths: ['connectionString', 'password', 'params', 'statement.params', 'statements.params'],
}

/** Redact a statement to its audit-safe shape: text kept, param values dropped. */
export function redactStatement(statement: PostgresStatement): {
  readonly text: string
  readonly paramCount: number
} {
  return { text: statement.text, paramCount: statement.params?.length ?? 0 }
}
