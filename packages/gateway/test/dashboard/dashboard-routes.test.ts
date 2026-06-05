import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore } from '@skelm/core'
import type { Run } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../../src/index.js'
import { pickFreePort } from '../utils/pick-free-port.js'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-dash-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

function makeRun(o: Partial<Run> & Pick<Run, 'runId'>): Run {
  return {
    pipelineId: 'wf-a',
    status: 'completed',
    input: undefined,
    steps: [],
    output: undefined,
    error: undefined,
    startedAt: Date.now() - 60_000,
    completedAt: Date.now() - 59_000,
    ...o,
  } as Run
}

async function bootGateway(): Promise<{
  gw: Gateway
  base: string
  port: number
  store: MemoryRunStore
}> {
  const port = await pickFreePort()
  const store = new MemoryRunStore()
  const gw = new Gateway({
    stateDir,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    runStore: store,
  })
  await gw.start()
  return { gw, base: `http://127.0.0.1:${port}`, port, store }
}

describe('GET /v1/dashboard/*', () => {
  it('returns overview composing runs, schedules, and approvals', async () => {
    const { gw, base, store } = await bootGateway()
    try {
      await store.putRun(makeRun({ runId: 'r1' }))
      await store.putRun(
        makeRun({ runId: 'r2', status: 'failed', error: { name: 'E', message: 'kaboom' } }),
      )

      const res = await fetch(`${base}/v1/dashboard/overview`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const json = await res.json()
      expect(json.gateway.status).toBe('running')
      expect(json.runs.total).toBe(2)
      expect(json.runs.byStatus.completed).toBe(1)
      expect(json.runs.byStatus.failed).toBe(1)
      expect(json.errors.last24h).toBe(1)
    } finally {
      await gw.stop()
    }
  })

  it('filters runs via /v1/dashboard/runs query params', async () => {
    const { gw, base, store } = await bootGateway()
    try {
      await store.putRun(
        makeRun({ runId: 'a', pipelineId: 'wf-a', startedAt: 100, completedAt: 200 }),
      )
      await store.putRun(
        makeRun({ runId: 'b', pipelineId: 'wf-b', startedAt: 300, completedAt: 400 }),
      )

      const all = await fetch(`${base}/v1/dashboard/runs`).then((r) => r.json())
      expect(all.runs).toHaveLength(2)

      const filtered = await fetch(`${base}/v1/dashboard/runs?workflowId=wf-b`).then((r) =>
        r.json(),
      )
      expect(filtered.runs).toHaveLength(1)
      expect(filtered.runs[0].runId).toBe('b')
    } finally {
      await gw.stop()
    }
  })

  it('returns analytics buckets for a date range', async () => {
    const { gw, base, store } = await bootGateway()
    try {
      const HOUR = 60 * 60 * 1000
      const t0 = Math.floor(1_800_000_000_000 / HOUR) * HOUR
      await store.putRun(makeRun({ runId: 'r1', startedAt: t0 + 60, completedAt: t0 + 100 }))
      await store.putRun(
        makeRun({ runId: 'r2', startedAt: t0 + 2 * HOUR + 30, completedAt: t0 + 2 * HOUR + 100 }),
      )

      const res = await fetch(
        `${base}/v1/dashboard/analytics?metric=runs-per-hour&resolution=hour&dateFrom=${t0}&dateTo=${t0 + 3 * HOUR}`,
      )
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.points).toHaveLength(3)
      expect(json.points.map((p: { value: number }) => p.value)).toEqual([1, 0, 1])
    } finally {
      await gw.stop()
    }
  })

  it('accepts metric=runs as an alias and exposes buckets', async () => {
    const { gw, base, store } = await bootGateway()
    try {
      const HOUR = 60 * 60 * 1000
      const t0 = Math.floor(1_800_000_000_000 / HOUR) * HOUR
      await store.putRun(makeRun({ runId: 'r1', startedAt: t0 + 60, completedAt: t0 + 100 }))

      const res = await fetch(
        `${base}/v1/dashboard/analytics?metric=runs&resolution=hour&dateFrom=${t0}&dateTo=${t0 + HOUR}`,
      )
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.metric).toBe('runs-per-hour')
      expect(json.buckets).toEqual(json.points)
      expect(json.series).toEqual(json.points)
    } finally {
      await gw.stop()
    }
  })

  it('returns schedules and approvals', async () => {
    const { gw, base } = await bootGateway()
    try {
      const schedules = await fetch(`${base}/v1/dashboard/schedules`).then((r) => r.json())
      expect(schedules).toEqual({ schedules: [] })

      const approvals = await fetch(`${base}/v1/dashboard/approvals`).then((r) => r.json())
      expect(approvals.pendingCount).toBe(0)
      expect(approvals.oldestPendingAgeMs).toBeNull()
    } finally {
      await gw.stop()
    }
  })

  it('rejects analytics with an unknown metric (400)', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/dashboard/analytics?metric=bogus`)
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('requires bearer token when auth is configured', async () => {
    const port = await pickFreePort()
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      token: 'sekret',
      config: {
        server: { host: '127.0.0.1', port, auth: { mode: 'bearer' } },
      },
    })
    await gw.start()
    try {
      const base = `http://127.0.0.1:${port}`
      const unauth = await fetch(`${base}/v1/dashboard/overview`)
      expect(unauth.status).toBe(401)

      const ok = await fetch(`${base}/v1/dashboard/overview`, {
        headers: { authorization: 'Bearer sekret' },
      })
      expect(ok.status).toBe(200)
    } finally {
      await gw.stop()
    }
  })
})
