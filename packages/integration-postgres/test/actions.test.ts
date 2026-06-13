import { describe, expect, it } from 'vitest'

import { execute, query, transaction, validateStatement } from '../src/actions.js'
import { PostgresValidationError } from '../src/errors.js'
import type {
  ExecutorProvider,
  PostgresResult,
  PostgresRow,
  PostgresStatement,
} from '../src/types.js'

/**
 * A fake executor that records every statement it receives and returns canned
 * rows. Crucially it captures `text` and `params` SEPARATELY, so a test can
 * assert that a malicious value arrives bound in `params` and never appears in
 * `text` — proving the parameterized-only contract structurally.
 */
function fakeProvider(
  respond: (statement: PostgresStatement, callIndex: number) => PostgresResult,
): {
  provider: ExecutorProvider
  calls: PostgresStatement[]
  acquired: number
  released: number
} {
  const calls: PostgresStatement[] = []
  const state = { acquired: 0, released: 0 }
  const provider: ExecutorProvider = {
    async acquire() {
      state.acquired += 1
      return {
        executor: {
          async query<TRow extends PostgresRow = PostgresRow>(statement: PostgresStatement) {
            calls.push(statement)
            return respond(statement, calls.length - 1) as PostgresResult<TRow>
          },
        },
        release: async () => {
          state.released += 1
        },
      }
    },
  }
  return {
    provider,
    calls,
    get acquired() {
      return state.acquired
    },
    get released() {
      return state.released
    },
  }
}

describe('validateStatement', () => {
  it('accepts a parameterized statement', () => {
    expect(() =>
      validateStatement({ text: 'SELECT * FROM t WHERE id = $1', params: [1] }),
    ).not.toThrow()
  })

  it('rejects empty text', () => {
    expect(() => validateStatement({ text: '   ' })).toThrow(PostgresValidationError)
  })

  it('rejects non-array params', () => {
    expect(() =>
      validateStatement({ text: 'SELECT 1', params: 'oops' as unknown as unknown[] }),
    ).toThrow(PostgresValidationError)
  })

  it('rejects placeholders with no params', () => {
    expect(() => validateStatement({ text: 'SELECT * FROM t WHERE id = $1' })).toThrow(
      PostgresValidationError,
    )
  })
})

describe('query', () => {
  it('returns rows and a redacted audit record', async () => {
    const f = fakeProvider(() => ({ rows: [{ id: 1, name: 'a' }], rowCount: 1 }))
    const { rows, audit } = await query(f.provider, {
      text: 'SELECT id, name FROM t WHERE id = $1',
      params: [1],
    })
    expect(rows).toEqual([{ id: 1, name: 'a' }])
    expect(audit.action).toBe('query')
    expect(audit.statements[0]).toEqual({
      text: 'SELECT id, name FROM t WHERE id = $1',
      paramCount: 1,
    })
    expect(f.acquired).toBe(1)
    expect(f.released).toBe(1)
  })

  it('releases the connection even when the query throws', async () => {
    const f = fakeProvider(() => {
      throw new Error('boom')
    })
    await expect(query(f.provider, { text: 'SELECT 1' })).rejects.toThrow('boom')
    expect(f.released).toBe(1)
  })
})

describe('execute', () => {
  it('returns rowCount for a write', async () => {
    const f = fakeProvider(() => ({ rows: [], rowCount: 3 }))
    const { rowCount, audit } = await execute(f.provider, {
      text: 'UPDATE t SET name = $1 WHERE active = $2',
      params: ['x', true],
    })
    expect(rowCount).toBe(3)
    expect(audit.action).toBe('execute')
    expect(audit.statements[0]?.paramCount).toBe(2)
  })
})

describe('transaction', () => {
  it('wraps statements in BEGIN/COMMIT and runs them in order', async () => {
    const f = fakeProvider((stmt) => ({
      rows: [],
      rowCount: stmt.text.startsWith('INSERT') ? 1 : 0,
    }))
    const { audit } = await transaction(f.provider, [
      { text: 'INSERT INTO t (name) VALUES ($1)', params: ['a'] },
      { text: 'INSERT INTO t (name) VALUES ($1)', params: ['b'] },
    ])
    expect(f.calls.map((c) => c.text)).toEqual([
      'BEGIN',
      'INSERT INTO t (name) VALUES ($1)',
      'INSERT INTO t (name) VALUES ($1)',
      'COMMIT',
    ])
    expect(audit.action).toBe('transaction')
    expect(audit.rowCount).toBe(2)
  })

  it('issues ROLLBACK when a statement fails', async () => {
    const f = fakeProvider((stmt) => {
      if (stmt.text.startsWith('INSERT')) throw new Error('constraint')
      return { rows: [], rowCount: 0 }
    })
    await expect(
      transaction(f.provider, [{ text: 'INSERT INTO t (name) VALUES ($1)', params: ['a'] }]),
    ).rejects.toThrow('constraint')
    expect(f.calls.map((c) => c.text)).toEqual([
      'BEGIN',
      'INSERT INTO t (name) VALUES ($1)',
      'ROLLBACK',
    ])
    expect(f.released).toBe(1)
  })

  it('rejects an empty statement list', async () => {
    const f = fakeProvider(() => ({ rows: [], rowCount: 0 }))
    await expect(transaction(f.provider, [])).rejects.toThrow(PostgresValidationError)
  })
})

describe('parameterized-only / injection inertness', () => {
  it('binds an injection attempt as a param value; it never enters text', async () => {
    const f = fakeProvider(() => ({ rows: [], rowCount: 0 }))
    const malicious = '1; DROP TABLE users; --'
    await query(f.provider, {
      text: 'SELECT * FROM accounts WHERE id = $1',
      params: [malicious],
    })
    const call = f.calls[0]
    expect(call).toBeDefined()
    // The payload is bound, not interpolated: text has no trace of it.
    expect(call?.text).toBe('SELECT * FROM accounts WHERE id = $1')
    expect(call?.text).not.toContain('DROP TABLE')
    expect(call?.params).toEqual([malicious])
  })
})
