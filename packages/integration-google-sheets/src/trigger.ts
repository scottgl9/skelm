/**
 * Polling trigger: detect rows appended to a sheet since the last poll.
 *
 * The cursor is the total row count observed on the previous poll. Each poll
 * reads metadata-free row data, compares the current count to the cursor, and
 * emits only the new rows. Durable cursor storage and scheduling are the
 * gateway's responsibility; this function is a pure, testable step.
 */

import { readRange } from './actions.js'
import type { SheetRow, ValueRenderOption } from './actions.js'
import type { SheetsRequestContext } from './client.js'

export interface NewRowsPollInput {
  /** Sheet/tab name to watch, e.g. `Sheet1`. */
  readonly sheet: string
  /** Row count observed on the previous poll; undefined on the first poll. */
  readonly cursor?: number
  /** Rightmost column to read. Defaults to `ZZZ`. */
  readonly endColumn?: string
  readonly valueRenderOption?: ValueRenderOption
}

export interface NewRowsPollResult {
  /** Rows that appeared after the cursor position. */
  readonly newRows: SheetRow[]
  /** Updated cursor (total row count) to persist for the next poll. */
  readonly cursor: number
}

/**
 * Poll a sheet for rows appended since `cursor`. On the first poll (no cursor)
 * the existing rows are treated as the baseline and no rows are emitted, so a
 * fresh trigger does not replay history.
 */
export async function pollNewRows(
  ctx: SheetsRequestContext,
  input: NewRowsPollInput,
): Promise<NewRowsPollResult> {
  const endColumn = input.endColumn ?? 'ZZZ'
  const { values } = await readRange(ctx, {
    range: `${input.sheet}!A1:${endColumn}`,
    ...(input.valueRenderOption ? { valueRenderOption: input.valueRenderOption } : {}),
  })
  const total = values.length
  if (input.cursor === undefined) return { newRows: [], cursor: total }
  if (total <= input.cursor) return { newRows: [], cursor: total }
  return { newRows: values.slice(input.cursor), cursor: total }
}
