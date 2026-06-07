import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { Pool as PgPool, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PostgresRunStoreOptions } from '../src/run-store-postgres.js'
import { ArtifactQuotaExceededError, PostgresRunStore } from '../src/run-store.js'
import type { Run } from '../src/types.js'

const postgresUrl = process.env.SKELM_TEST_POSTGRES_URL
const describeMaybe = postgresUrl === undefined ? describe.skip : describe

let admin: Pool | null = null

beforeAll(async () => {
  if (postgresUrl === undefined) return
  admin = new PgPool({ connectionString: postgresUrl })
  const conn = await admin.connect()
  await conn.query('SELECT 1')
  conn.release()
})

afterAll(async () => {
  if (admin !== null) await admin.end()
})

describeMaybe('PostgresRunStore contract', () => {
  it('stores runs and events', async () => {
    const { store, cleanup } = await withSchemaStore()
    try {
      const run = sampleRun('r-run-events')
      await store.putRun(run)
      await store.appendEvent({ type: 'run.started', runId: run.runId, at: 2 })
      await store.appendEvent({ type: 'run.completed', runId: run.runId, at: 1 })
      await store.appendEvent({ type: 'step.start', runId: run.runId, stepId: 'a', at: 3 })
      await store.appendEvent({ type: 'step.complete', runId: run.runId, stepId: 'a', at: 3 })

      await expect(store.getRun('r-run-events')).resolves.toEqual(run)
      expect(await collect(store.listRuns({ limit: 10 }))).toEqual([
        {
          runId: 'r-run-events',
          pipelineId: 'p',
          status: 'completed',
          startedAt: 1,
          completedAt: 2,
          workflowPath: '/repo/pipeline.ts',
          triggerId: 'trigger-a',
        },
      ])
      const events = await collect(store.listEvents('r-run-events'))
      expect(events).toEqual([
        { type: 'run.completed', runId: 'r-run-events', at: 1 },
        { type: 'run.started', runId: 'r-run-events', at: 2 },
        { type: 'step.start', runId: 'r-run-events', stepId: 'a', at: 3 },
        { type: 'step.complete', runId: 'r-run-events', stepId: 'a', at: 3 },
      ])
    } finally {
      await cleanup()
    }
  })

  it('updates runs by patch transactionally', async () => {
    const { store, cleanup } = await withSchemaStore()
    try {
      await store.putRun(sampleRun('r-run-update'))
      await Promise.all([
        store.updateRun('r-run-update', {
          status: 'failed',
          error: { name: 'Boom', message: 'broken' },
        }),
        store.updateRun('r-run-update', {
          status: 'cancelled',
          waiting: { stepId: 'wait', since: 10 },
        }),
      ])
      const updated = await store.getRun('r-run-update')
      expect(updated).not.toBeNull()
      expect(['failed', 'cancelled']).toContain(updated.status)
    } finally {
      await cleanup()
    }
  })

  it('stores and reads state entries, streams, and CAS updates', async () => {
    const { store, cleanup } = await withSchemaStore()
    try {
      await store.setState('pipeline:one', 'flag', true)
      expect(await store.getState<boolean>('pipeline:one', 'flag')).toBe(true)

      await store.appendState('pipeline:one', 'decisions', { ok: true })
      await store.appendState('pipeline:one', 'decisions', { ok: false })
      expect(await collect(store.readState('pipeline:one', 'decisions'))).toEqual([
        { ok: true },
        { ok: false },
      ])
      expect(await collect(store.readState('pipeline:one', 'decisions', { limit: 1 }))).toEqual([
        { ok: true },
      ])
      const readWithSince = await collect(
        store.readState('pipeline:one', 'decisions', { since: 1, limit: 2 }),
      )
      expect(readWithSince).toEqual([{ ok: true }, { ok: false }])

      expect(await collect(store.listState('pipeline:one'))).toEqual([{ key: 'flag', value: true }])
      expect(await collect(store.listState('pipeline:one', 'fl'))).toEqual([
        { key: 'flag', value: true },
      ])
      expect(await collect(store.listState('pipeline:one', 'zzz'))).toEqual([])

      expect(await store.casState('pipeline:one', 'flag', true, false)).toBe(true)
      expect(await store.casState('pipeline:one', 'flag', true, true)).toBe(false)
      expect(await store.getState<boolean>('pipeline:one', 'flag')).toBe(false)

      await store.setState('pipeline:one', 'ordered', { b: 2, a: 1 })
      expect(await store.casState('pipeline:one', 'ordered', { a: 1, b: 2 }, { ok: true })).toBe(
        true,
      )

      expect(await store.getState('pipeline:one', 'missing')).toBeUndefined()
      expect(
        await store.casState('pipeline:one', 'missing', undefined, {
          created: true,
        }),
      ).toBe(true)
      expect(await store.getState('pipeline:one', 'missing')).toEqual({ created: true })
    } finally {
      await cleanup()
    }
  })

  it('enforces artifact quota atomically under concurrent writes', async () => {
    const { store, cleanup } = await withSchemaStore({ artifactQuotaBytes: 10 })
    try {
      const runId = `r-art-concurrent-${randomUUID().replaceAll('-', '')}`
      const concurrentWrites = [1, 2, 3, 4].map(() =>
        store.putArtifact({
          runId,
          name: `artifact-${randomUUID()}`,
          mimeType: 'text/plain',
          data: 'data',
        }),
      )
      const outcomes = await Promise.allSettled(concurrentWrites)
      const succeeded = outcomes.filter((outcome) => outcome.status === 'fulfilled').length
      const failed = outcomes.filter(
        (outcome) =>
          outcome.status === 'rejected' && outcome.reason instanceof ArtifactQuotaExceededError,
      )
      expect(succeeded).toBe(2)
      expect(failed).toHaveLength(2)

      const remaining = await collectArtifactNames(store, runId)
      expect(remaining).toHaveLength(2)
      expect(remaining.every((name) => name.startsWith('artifact-'))).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('expires state entries once ttl elapses', async () => {
    const { store, cleanup } = await withSchemaStore()
    try {
      const key = `ttl-${randomUUID()}`
      await store.setState('pipeline:ttl', key, 'value', { ttlMs: 100 })
      expect(await store.getState('pipeline:ttl', key)).toBe('value')
      await setTimeout(120)
      expect(await store.getState('pipeline:ttl', key)).toBeUndefined()
      expect(await collect(store.listState('pipeline:ttl'))).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('enforces artifact quota and returns byte-accurate descriptors', async () => {
    const { store, cleanup } = await withSchemaStore({ artifactQuotaBytes: 10 })
    try {
      const small = await store.putArtifact({
        runId: 'r-art',
        name: 'small',
        mimeType: 'text/plain',
        data: new Uint8Array([0, 1, 2, 3]),
      })
      await expect(
        store.putArtifact({
          runId: 'r-art',
          name: 'too-big',
          mimeType: 'text/plain',
          data: '01234567890',
        }),
      ).rejects.toBeInstanceOf(ArtifactQuotaExceededError)
      const seen = await collectArtifactNames(store, 'r-art')
      expect(small.size).toBe(4)
      expect(seen).toEqual(['small'])
    } finally {
      await cleanup()
    }
  })

  it('persists state across store reopen for recovery', async () => {
    const schema = `skelm_reopen_${randomUUID().replaceAll('-', '')}`
    if (admin === null || postgresUrl === undefined) {
      throw new Error('postgres admin/client is not configured')
    }
    const dbUrl = postgresUrl
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`)
    const firstStore = new PostgresRunStore({ url: dbUrl, schema })
    const key = 'restart-key'
    let secondStore: PostgresRunStore | null = null
    let firstStoreClosed = false
    try {
      await firstStore.setState('pipeline:recovery', key, { count: 1 })
      await firstStore.appendState('pipeline:recovery', 'decisions', { phase: 'first' })

      await firstStore.close()
      firstStoreClosed = true
      secondStore = new PostgresRunStore({ url: dbUrl, schema })
      expect(await secondStore.getState<{ count: number }>('pipeline:recovery', key)).toEqual({
        count: 1,
      })
      expect(await collect(secondStore.readState('pipeline:recovery', 'decisions'))).toEqual([
        { phase: 'first' },
      ])
    } finally {
      if (secondStore !== null) {
        await secondStore.close()
      }
      if (!firstStoreClosed) {
        await firstStore.close()
      }
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
    }
  })

  it('serializes concurrent CAS updates', async () => {
    const { store, cleanup } = await withSchemaStore()
    try {
      for (let i = 0; i < 8; i += 1) {
        const key = `k-${i}-${Date.now()}-${randomUUID()}`
        await store.setState('pipeline:concurrent', key, 0)
        const outcomes = await Promise.all([
          store.casState('pipeline:concurrent', key, 0, i + 1),
          store.casState('pipeline:concurrent', key, 0, i + 2),
        ])
        expect(outcomes.filter(Boolean)).toHaveLength(1)
      }
    } finally {
      await cleanup()
    }
  })
})

async function withSchemaStore(
  opts: PostgresRunStoreOptions = {},
): Promise<{ store: PostgresRunStore; cleanup: () => Promise<void> }> {
  if (admin === null || postgresUrl === undefined) {
    throw new Error('postgres admin/client is not configured')
  }
  const schema = `skelm_test_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`)
  const store = new PostgresRunStore({ url: postgresUrl, schema, ...opts })
  return {
    store,
    cleanup: async () => {
      await store.close()
      const adminClient = admin
      if (adminClient !== null) {
        await adminClient.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
      }
    },
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) {
    out.push(item)
  }
  return out
}

async function collectArtifactNames(store: PostgresRunStore, runId: string): Promise<string[]> {
  const names: string[] = []
  for await (const artifact of store.listArtifacts(runId)) {
    names.push(artifact.name)
  }
  return names
}

function sampleRun(runId: string): Run {
  return {
    runId,
    pipelineId: 'p',
    status: 'completed',
    input: { ok: true },
    steps: [],
    output: { ok: true },
    error: undefined,
    startedAt: 1,
    completedAt: 2,
    workflowPath: '/repo/pipeline.ts',
    triggerId: 'trigger-a',
  }
}

function quoteIdent(raw: string): string {
  return `"${raw.replaceAll('"', '""')}"`
}
