import { describe, expect, it } from 'vitest'

import { query, transaction } from '../src/actions.js'
import { POSTGRES_AUDIT_REDACTION, redactStatement } from '../src/redaction.js'
import type { ExecutorProvider, PostgresRow, PostgresStatement } from '../src/types.js'

function noopProvider(): ExecutorProvider {
  return {
    async acquire() {
      return {
        executor: {
          async query<TRow extends PostgresRow = PostgresRow>(_statement: PostgresStatement) {
            return { rows: [] as TRow[], rowCount: 0 }
          },
        },
        release: async () => {},
      }
    },
  }
}

describe('redactStatement', () => {
  it('keeps text and drops param values', () => {
    const out = redactStatement({
      text: 'UPDATE users SET token = $1 WHERE id = $2',
      params: ['secret-token-value', 42],
    })
    expect(out).toEqual({ text: 'UPDATE users SET token = $1 WHERE id = $2', paramCount: 2 })
    expect(JSON.stringify(out)).not.toContain('secret-token-value')
  })
})

describe('audit records carry no param values', () => {
  it('query audit has no param values', async () => {
    const { audit } = await query(noopProvider(), {
      text: 'SELECT * FROM users WHERE email = $1',
      params: ['alice@example.com'],
    })
    expect(JSON.stringify(audit)).not.toContain('alice@example.com')
  })

  it('transaction audit has no param values', async () => {
    const { audit } = await transaction(noopProvider(), [
      { text: 'INSERT INTO secrets (v) VALUES ($1)', params: ['top-secret'] },
    ])
    expect(JSON.stringify(audit)).not.toContain('top-secret')
  })
})

describe('redaction policy', () => {
  it('names connection string and params as redaction paths', () => {
    expect(POSTGRES_AUDIT_REDACTION.redactPaths).toContain('connectionString')
    expect(POSTGRES_AUDIT_REDACTION.redactPaths).toContain('password')
    expect(POSTGRES_AUDIT_REDACTION.redactPaths).toContain('params')
  })
})
