import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-schedules-meta-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

async function startUnprotectedGateway() {
  return await bootGatewayWithRetry((port) => ({
    stateDir,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    config: {},
  }))
}

describe('HTTP schedule metadata', () => {
  it('reports stable scheduler metadata without exposing webhook secrets', async () => {
    const { gw, base } = await startUnprotectedGateway()
    try {
      const create = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'webhook-meta',
          workflowId: 'wf',
          trigger: {
            kind: 'webhook',
            path: '/hooks/meta',
            secret: 'do-not-return',
            provider: 'slack',
            replayWindowSeconds: 60,
          },
          overlap: 'queue',
        }),
      })
      expect(create.status).toBe(200)
      const created = await create.json()

      expect(created).toMatchObject({
        id: 'webhook-meta',
        workflowId: 'wf',
        overlap: 'queue',
        enabled: true,
        fired: 0,
        inflight: false,
        queued: 0,
        dropped: 0,
        runningCount: 0,
        trigger: {
          kind: 'webhook',
          path: '/hooks/meta',
          provider: 'slack',
          replayWindowSeconds: 60,
        },
      })
      expect(JSON.stringify(created)).not.toContain('do-not-return')

      const listed = await fetch(`${base}/schedules`).then((r) => r.json())
      expect(listed).toEqual([created])
    } finally {
      await gw.stop()
    }
  })

  it('reports nextFireAt and overlap outcomes for interval schedules', async () => {
    const { gw, base } = await startUnprotectedGateway()
    try {
      const create = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'interval-meta',
          workflowId: 'wf',
          trigger: { kind: 'interval', everyMs: 60_000 },
          overlap: 'skip',
        }),
      })
      expect(create.status).toBe(200)
      const created = await create.json()
      expect(Date.parse(created.nextFireAt)).not.toBeNaN()

      const fire = await fetch(`${base}/triggers/interval-meta/fire`, { method: 'POST' })
      expect(fire.status).toBe(200)

      const schedule = await fetch(`${base}/schedules/interval-meta`).then((r) => r.json())
      expect(schedule.nextFireAt).toBe(created.nextFireAt)
      expect(schedule.lastFiredAt).toEqual(expect.any(String))
      expect(schedule.lastOutcome).toBe('succeeded')
      expect(schedule.lastOverlapDecision).toBe('dispatched')
    } finally {
      await gw.stop()
    }
  })
})
