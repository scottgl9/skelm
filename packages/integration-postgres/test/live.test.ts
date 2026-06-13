import { shouldRunLiveTest } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'

import { execute, query, transaction } from '../src/actions.js'
import { poolExecutorProvider } from '../src/connection.js'
import { POSTGRES_LIVE_TEST } from '../src/manifest.js'
import type { ExecutorProvider } from '../src/types.js'

/**
 * Live DB tests. Opt-in only: gated on SKELM_LIVE_POSTGRES=1 and a connection
 * string in SKELM_LIVE_POSTGRES_URL. When either is absent the suite reports a
 * clean skip and never fails default CI — no database is required.
 */
const live = shouldRunLiveTest(POSTGRES_LIVE_TEST)

describe.skipIf(!live)('live postgres round-trip', () => {
  let provider: ExecutorProvider
  const table = `skelm_live_${Date.now().toString(36)}`

  it('round-trips parameterized values and proves injection is inert', async () => {
    provider = poolExecutorProvider({ connectionString: process.env.SKELM_LIVE_POSTGRES_URL })

    await execute(provider, {
      text: `CREATE TABLE ${table} (id SERIAL PRIMARY KEY, label TEXT NOT NULL)`,
    })
    try {
      const injection = `x'); DROP TABLE ${table}; --`
      const ins = await execute(provider, {
        text: `INSERT INTO ${table} (label) VALUES ($1)`,
        params: [injection],
      })
      expect(ins.rowCount).toBe(1)

      // The table still exists (DROP was bound as data, not executed).
      const sel = await query<{ label: string }>(provider, {
        text: `SELECT label FROM ${table} WHERE label = $1`,
        params: [injection],
      })
      expect(sel.rows).toHaveLength(1)
      expect(sel.rows[0]?.label).toBe(injection)

      const tx = await transaction(provider, [
        { text: `INSERT INTO ${table} (label) VALUES ($1)`, params: ['a'] },
        { text: `INSERT INTO ${table} (label) VALUES ($1)`, params: ['b'] },
      ])
      expect(tx.audit.rowCount).toBe(2)
    } finally {
      await execute(provider, { text: `DROP TABLE IF EXISTS ${table}` })
    }
  })
})

it('live suite is skipped cleanly when env is absent', () => {
  if (!live) {
    expect(shouldRunLiveTest(POSTGRES_LIVE_TEST, {})).toBe(false)
  }
})
