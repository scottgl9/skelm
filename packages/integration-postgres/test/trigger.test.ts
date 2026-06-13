import { describe, expect, it } from 'vitest'

import { PostgresValidationError } from '../src/errors.js'
import { pollOnce } from '../src/trigger.js'
import type { ExecutorProvider, PostgresRow, PostgresStatement } from '../src/types.js'

function rowsProvider(
  rows: PostgresRow[],
  onCall?: (s: PostgresStatement) => void,
): ExecutorProvider {
  return {
    async acquire() {
      return {
        executor: {
          async query<TRow extends PostgresRow = PostgresRow>(statement: PostgresStatement) {
            onCall?.(statement)
            return { rows: rows as TRow[], rowCount: rows.length }
          },
        },
        release: async () => {},
      }
    },
  }
}

describe('pollOnce', () => {
  it('emits normalized envelopes and advances the cursor', async () => {
    const provider = rowsProvider([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    const result = await pollOnce(
      provider,
      { table: 'events', cursorColumn: 'id' },
      undefined,
      () => 1234,
    )
    expect(result.events).toHaveLength(2)
    expect(result.events[0]?.source).toBe('postgres')
    expect(result.events[0]?.type).toBe('events.changed')
    expect(result.events[0]?.payload).toEqual({ id: 1, name: 'a' })
    expect(result.cursor).toBe(2)
  })

  it('binds the cursor as a param, never interpolated', async () => {
    let seen: PostgresStatement | undefined
    const provider = rowsProvider([], (s) => {
      seen = s
    })
    await pollOnce(provider, { table: 'events', cursorColumn: 'id' }, 99)
    expect(seen?.text).toContain('WHERE id > $1')
    expect(seen?.text).not.toContain('99')
    expect(seen?.params).toEqual([99])
  })

  it('rejects an unsafe table identifier', async () => {
    const provider = rowsProvider([])
    await expect(
      pollOnce(provider, { table: 'events; DROP TABLE x', cursorColumn: 'id' }, undefined),
    ).rejects.toThrow(PostgresValidationError)
  })

  it('rejects an unsafe cursor column identifier', async () => {
    const provider = rowsProvider([])
    await expect(
      pollOnce(provider, { table: 'events', cursorColumn: 'id; --' }, undefined),
    ).rejects.toThrow(PostgresValidationError)
  })
})
