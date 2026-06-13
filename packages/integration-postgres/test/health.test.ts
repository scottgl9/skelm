import { describe, expect, it } from 'vitest'

import { checkHealth } from '../src/health.js'
import type { ExecutorProvider, PostgresRow, PostgresStatement } from '../src/types.js'

function provider(behavior: 'ok' | 'no-row' | 'throw'): ExecutorProvider {
  return {
    async acquire() {
      if (behavior === 'throw') throw new Error('connection refused')
      return {
        executor: {
          async query<TRow extends PostgresRow = PostgresRow>(_s: PostgresStatement) {
            const rows = behavior === 'ok' ? [{ ok: 1 }] : []
            return { rows: rows as unknown as TRow[], rowCount: rows.length }
          },
        },
        release: async () => {},
      }
    },
  }
}

describe('checkHealth', () => {
  it('reports ok when SELECT 1 returns a row', async () => {
    const result = await checkHealth(provider('ok'))
    expect(result.healthy).toBe(true)
    expect(result.status).toBe('ok')
  })

  it('reports unhealthy when no row comes back', async () => {
    const result = await checkHealth(provider('no-row'))
    expect(result.healthy).toBe(false)
    expect(result.status).toBe('unhealthy')
  })

  it('reports error without leaking detail when connecting throws', async () => {
    const result = await checkHealth(provider('throw'))
    expect(result.healthy).toBe(false)
    expect(result.status).toBe('error')
    expect(result.detail).toBe('health check failed')
    expect(JSON.stringify(result)).not.toContain('connection refused')
  })
})
