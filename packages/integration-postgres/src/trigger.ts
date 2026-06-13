/**
 * Polling trigger: detect new rows via a monotonic cursor column.
 *
 * Postgres LISTEN/NOTIFY needs a held connection and is awkward under the
 * gateway's dispatch-time Pool model, so the default trigger is a poll over a
 * cursor column (e.g. an auto-incrementing id or an `updated_at`). The cursor is
 * always bound as a parameter — never interpolated — so the poll inherits the
 * same SQL-injection safety as the actions. The trigger reuses the SDK
 * {@link normalizeWebhook} envelope shape for each emitted change.
 */

import { type EventEnvelope, normalizeWebhook } from '@skelm/integration-sdk'

import { validateStatement } from './actions.js'
import { PostgresValidationError } from './errors.js'
import type { ExecutorProvider, PostgresRow } from './types.js'

/** Configuration for a polling trigger over a cursor column. */
export interface PollTriggerConfig {
  /** Fully-qualified table name as raw SQL identifier text (operator-controlled, not user input). */
  readonly table: string
  /** Monotonic cursor column (e.g. `id` or `updated_at`). Operator-controlled identifier. */
  readonly cursorColumn: string
  /** Event type stamped onto each emitted envelope. Defaults to `<table>.changed`. */
  readonly eventType?: string
  /** Max rows fetched per poll. Defaults to 100. */
  readonly batchSize?: number
}

/** Cursor state carried between polls. `undefined` starts from the beginning. */
export type PollCursor = string | number | undefined

/** One poll's outcome: emitted events plus the advanced cursor. */
export interface PollResult<TRow extends PostgresRow = PostgresRow> {
  readonly events: readonly EventEnvelope<TRow>[]
  readonly cursor: PollCursor
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*$/

function assertIdentifier(value: string, label: string): void {
  if (!IDENT.test(value)) {
    throw new PostgresValidationError(
      `${label} must be a simple SQL identifier (got an unsafe value)`,
    )
  }
}

/**
 * Run one poll. Fetches rows with a cursor strictly greater than `cursor`
 * (bound as a parameter), ordered by the cursor column, capped at `batchSize`.
 * Returns normalized envelopes and the new high-water cursor.
 */
export async function pollOnce<TRow extends PostgresRow = PostgresRow>(
  provider: ExecutorProvider,
  config: PollTriggerConfig,
  cursor: PollCursor,
  now: () => number = Date.now,
): Promise<PollResult<TRow>> {
  // Identifiers are operator config, not user input; still validate to keep the
  // generated SQL well-formed and reject obviously unsafe identifiers.
  assertIdentifier(config.table, 'table')
  assertIdentifier(config.cursorColumn, 'cursorColumn')

  const batchSize = config.batchSize ?? 100
  const eventType = config.eventType ?? `${config.table}.changed`
  const col = config.cursorColumn

  const where = cursor === undefined ? '' : `WHERE ${col} > $1`
  const params = cursor === undefined ? [] : [cursor]
  const statement = {
    text: `SELECT * FROM ${config.table} ${where} ORDER BY ${col} ASC LIMIT ${Number(batchSize)}`,
    params,
  }
  validateStatement(statement)

  const { executor, release } = await provider.acquire()
  try {
    const result = await executor.query<TRow>(statement)
    let next: PollCursor = cursor
    const events = result.rows.map((row) => {
      const value = (row as PostgresRow)[col]
      if (typeof value === 'number' || typeof value === 'string') next = value
      return normalizeWebhook<TRow>({
        source: 'postgres',
        type: eventType,
        payload: row,
        receivedAt: now(),
      })
    })
    return { events, cursor: next }
  } finally {
    await release()
  }
}
