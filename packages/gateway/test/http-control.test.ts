import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { code, parallel, pipeline, wait } from '@skelm/core'
import { MemoryRunStore } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Gateway, InMemoryQueueDriver, type SuspendApprovalGate } from '../src/index.js'
import { bootGatewayWithRetry } from './utils/boot-gateway.js'
import { pickFreePort } from './utils/pick-free-port.js'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-http-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

async function expectSettlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`promise did not settle within ${ms}ms`))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('Gateway HTTP control surface', () => {
  it('exposes /health, /gateway/pause|resume, /approvals, /sessions, /triggers', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
    }))

    try {
      const health = await fetch(`${base}/health`).then((r) => r.json())
      expect(health.status).toBe('ok')
      expect(health.state).toBe('running')

      // Liveness vs readiness split: /healthz mirrors /health; /readyz is
      // 200 only when state==='running'; both return JSON.
      const healthz = await fetch(`${base}/healthz`)
      expect(healthz.status).toBe(200)
      const healthzBody = await healthz.json()
      expect(healthzBody.status).toBe('ok')
      const readyz = await fetch(`${base}/readyz`)
      expect(readyz.status).toBe(200)
      const readyBody = await readyz.json()
      expect(readyBody.status).toBe('ready')

      const pause = await fetch(`${base}/gateway/pause`, { method: 'POST' }).then((r) => r.json())
      expect(pause.state).toBe('paused')
      const resume = await fetch(`${base}/gateway/resume`, { method: 'POST' }).then((r) => r.json())
      expect(resume.state).toBe('running')

      const approvals = await fetch(`${base}/approvals`).then((r) => r.json())
      expect(approvals).toEqual([])

      const sessions = await fetch(`${base}/sessions`).then((r) => r.json())
      expect(sessions).toEqual([])

      const triggers = await fetch(`${base}/triggers`).then((r) => r.json())
      expect(triggers).toEqual([])

      // Approve a manually-staged pending approval and verify the gate resolves.
      const gate = gw.enforcement.approvalGate as SuspendApprovalGate
      const decision = gate.request({
        runId: 'run-x',
        stepId: 'step-y',
        action: 'agent.start',
        context: {},
      })
      // Allow persist() to flush before reading the snapshot.
      await new Promise((r) => setTimeout(r, 20))
      const queue = await fetch(`${base}/approvals`).then((r) => r.json())
      expect(queue).toHaveLength(1)
      expect(queue[0].id).toBe('run-x:step-y')

      const approveRes = await fetch(`${base}/runs/run-x/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stepId: 'step-y', approver: 'cli', reason: 'ok' }),
      }).then((r) => r.json())
      expect(approveRes).toEqual({ delivered: true })

      const resolved = await decision
      expect(resolved.approved).toBe(true)
      expect(resolved.approver).toBe('cli')
    } finally {
      await gw.stop()
    }
  })

  it('persists the approval queue snapshot to <stateDir>/approvals.json', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
    }))
    try {
      const gate = gw.enforcement.approvalGate as SuspendApprovalGate
      const p = gate.request({ runId: 'r', stepId: 's', action: 'agent.start', context: {} })
      await new Promise((r) => setTimeout(r, 20))
      const raw = await fs.readFile(join(stateDir, 'approvals.json'), 'utf8')
      const snap = JSON.parse(raw)
      expect(snap).toHaveLength(1)
      expect(snap[0]).toMatchObject({ id: 'r:s', runId: 'r', stepId: 's' })
      gate.deny('r:s', 'cli', 'no')
      await p.catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      const after = JSON.parse(await fs.readFile(join(stateDir, 'approvals.json'), 'utf8'))
      expect(after).toEqual([])
    } finally {
      await gw.stop()
    }
  })
})

describe('Gateway HTTP /runs/:runId/events', () => {
  it('returns persisted run events from the run store', async () => {
    // config: {} is no longer required for stateDir isolation since the
    // DEFAULT_CONFIG storage path was removed; left here as an explicit
    // marker that this test owns its storage scope.
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      await gw.runStore.putRun({
        runId: 'r-events',
        pipelineId: 'p',
        status: 'completed',
        input: {},
        steps: [],
        output: undefined,
        error: undefined,
        startedAt: 1,
        completedAt: 2,
      })
      await gw.runStore.appendEvent({
        type: 'run.created',
        runId: 'r-events',
        pipelineId: 'p',
        input: {},
        at: 1,
      })
      await gw.runStore.appendEvent({ type: 'run.started', runId: 'r-events', at: 2 })

      const res = (await fetch(`${base}/runs/r-events/events`).then((r) => r.json())) as {
        runId: string
        events: Array<{ type: string }>
      }
      expect(res.runId).toBe('r-events')
      expect(res.events.map((e) => e.type)).toEqual(['run.created', 'run.started'])

      const limited = (await fetch(`${base}/runs/r-events/events?limit=1`).then((r) =>
        r.json(),
      )) as { events: Array<{ type: string }> }
      expect(limited.events).toHaveLength(1)

      const since = (await fetch(`${base}/runs/r-events/events?since=2`).then((r) => r.json())) as {
        events: Array<{ type: string }>
      }
      expect(since.events.map((e) => e.type)).toEqual(['run.started'])
    } finally {
      await gw.stop()
    }
  })

  it('returns 404 when the run does not exist', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const res = await fetch(`${base}/runs/missing/events`)
      expect(res.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })
})

describe('Gateway HTTP DELETE /runs/:runId', () => {
  it('aborts the run AbortController and 404s for unknown / completed runs', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const controller = new AbortController()
      let aborted = false
      let abortReason: unknown = undefined
      controller.signal.addEventListener('abort', () => {
        aborted = true
        abortReason = controller.signal.reason
      })
      gw.registerRun('run-cancel', controller)

      const res = await fetch(`${base}/runs/run-cancel`, { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ cancelled: true, runId: 'run-cancel' })
      expect(aborted).toBe(true)
      expect(abortReason).toBe('cancelled via HTTP DELETE')

      const second = await fetch(`${base}/runs/run-cancel`, { method: 'DELETE' })
      expect(second.status).toBe(404)

      const unknown = await fetch(`${base}/runs/never-started`, { method: 'DELETE' })
      expect(unknown.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })
})

describe('Gateway HTTP webhook trigger dispatch', () => {
  it('forwards POST to a registered webhook path to the trigger coordinator', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const fired: string[] = []
      gw.managers.triggers.setOnFire(async (ctx) => {
        fired.push(ctx.triggerId)
      })
      gw.managers.triggers.register({
        kind: 'webhook',
        id: 'gh-push',
        workflowId: 'wf',
        path: '/hooks/github',
        method: 'POST',
        secret: 'shh',
      })

      // Wrong secret → 401.
      const denied = await fetch(`${base}/hooks/github`, {
        method: 'POST',
        headers: { 'x-webhook-secret': 'nope' },
      })
      expect(denied.status).toBe(401)
      expect(fired).toEqual([])

      // Correct secret → fires.
      const ok = await fetch(`${base}/hooks/github`, {
        method: 'POST',
        headers: { 'x-webhook-secret': 'shh' },
      })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ ok: true, triggerId: 'gh-push' })
      expect(fired).toEqual(['gh-push'])

      // Unknown path → falls through (no webhook handler matches).
      const missing = await fetch(`${base}/hooks/unknown`, { method: 'POST' })
      expect(missing.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })

  it('forwards the parsed body + headers as the trigger payload', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const payloads: unknown[] = []
      gw.managers.triggers.setOnFire(async (ctx) => {
        payloads.push(ctx.payload)
      })
      gw.managers.triggers.register({
        kind: 'webhook',
        id: 'echo',
        workflowId: 'wf',
        path: '/hooks/echo',
        method: 'POST',
      })
      const res = await fetch(`${base}/hooks/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request' },
        body: JSON.stringify({ action: 'opened' }),
      })
      expect(res.status).toBe(200)
      expect(payloads).toHaveLength(1)
      const p = payloads[0] as {
        body: { action: string }
        headers: Record<string, string>
        path: string
        method: string
      }
      expect(p.body).toEqual({ action: 'opened' })
      expect(p.headers['x-github-event']).toBe('pull_request')
      expect(p.path).toBe('/hooks/echo')
      expect(p.method).toBe('POST')
    } finally {
      await gw.stop()
    }
  })

  it('deduplicates webhook deliveries by header within the TTL', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const fired: string[] = []
      gw.managers.triggers.setOnFire(async (ctx) => {
        fired.push(ctx.triggerId)
      })
      gw.managers.triggers.register({
        kind: 'webhook',
        id: 'gh-pr',
        workflowId: 'wf',
        path: '/hooks/gh-pr',
        method: 'POST',
        dedupe: { header: 'X-GitHub-Delivery', ttlMs: 60_000 },
      })

      // First delivery fires.
      const first = await fetch(`${base}/hooks/gh-pr`, {
        method: 'POST',
        headers: { 'x-github-delivery': 'abc-123' },
      })
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({ ok: true, triggerId: 'gh-pr' })

      // Replay with the same delivery id is deduped.
      const replay = await fetch(`${base}/hooks/gh-pr`, {
        method: 'POST',
        headers: { 'x-github-delivery': 'abc-123' },
      })
      expect(replay.status).toBe(200)
      expect(await replay.json()).toEqual({ ok: true, triggerId: 'gh-pr', deduped: true })

      // A fresh delivery id fires again.
      const second = await fetch(`${base}/hooks/gh-pr`, {
        method: 'POST',
        headers: { 'x-github-delivery': 'def-456' },
      })
      expect(second.status).toBe(200)

      expect(fired).toEqual(['gh-pr', 'gh-pr'])

      // Missing delivery header — defensive default: fire (do not silently drop).
      const noHeader = await fetch(`${base}/hooks/gh-pr`, { method: 'POST' })
      expect(noHeader.status).toBe(200)
      expect(fired).toEqual(['gh-pr', 'gh-pr', 'gh-pr'])
    } finally {
      await gw.stop()
    }
  })
})

describe('Gateway HTTP /schedules', () => {
  it('POST /schedules registers a trigger via the coordinator and GET lists them', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const empty = await fetch(`${base}/schedules`).then((r) => r.json())
      expect(empty).toEqual([])

      const created = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's-cron',
          workflowId: 'wf',
          trigger: { kind: 'cron', expression: '*/5 * * * *' },
          overlap: 'skip',
        }),
      }).then((r) => r.json())
      expect(created.id).toBe('s-cron')
      expect(created.trigger).toEqual({ kind: 'cron', expression: '*/5 * * * *' })

      // Listing now reflects the registered trigger.
      const list = (await fetch(`${base}/schedules`).then((r) => r.json())) as Array<{
        id: string
      }>
      expect(list.map((s) => s.id)).toEqual(['s-cron'])
    } finally {
      await gw.stop()
    }
  })

  it('POST /schedules rejects unknown overlap values with 400 (#184)', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const res = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's-bad-overlap',
          workflowId: 'wf',
          trigger: { kind: 'manual' },
          overlap: 'fail-fast', // not a valid OverlapPolicy
        }),
      })
      expect(res.status).toBe(400)
      // h3's default error renderer returns only `{statusCode}` in the body
      // and a generic "Bad Request" statusText, so we verify the route did
      // NOT register the trigger as a stronger signal than text matching.
      const listing = (await fetch(`${base}/schedules`).then((r) => r.json())) as Array<unknown>
      expect(listing).toEqual([])
    } finally {
      await gw.stop()
    }
  })

  it('POST /schedules accepts `every` duration strings and round-trips through GET', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const created = (await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's-interval-every',
          workflowId: 'wf',
          trigger: { kind: 'interval', every: '30m' },
        }),
      }).then((r) => r.json())) as { id: string; trigger: Record<string, unknown> }
      expect(created.id).toBe('s-interval-every')
      // The HTTP layer resolves `every` via parseDuration; both the resolved
      // ms and the original string come back so observers can show either.
      expect(created.trigger).toEqual({ kind: 'interval', everyMs: 1_800_000, every: '30m' })

      const list = (await fetch(`${base}/schedules`).then((r) => r.json())) as Array<{
        id: string
        trigger: Record<string, unknown>
      }>
      expect(list.find((s) => s.id === 's-interval-every')?.trigger).toEqual({
        kind: 'interval',
        everyMs: 1_800_000,
        every: '30m',
      })

      // Unparseable `every` values are rejected at the HTTP boundary rather
      // than registering a never-firing schedule.
      const bad = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's-interval-bad',
          workflowId: 'wf',
          trigger: { kind: 'interval', every: 'soon' },
        }),
      })
      expect(bad.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('POST /schedules persists `input` and GET /schedules echoes it back', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const created = (await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's-with-input',
          workflowId: 'wf',
          trigger: { kind: 'cron', expression: '*/5 * * * *' },
          input: { user: 'alice', level: 3 },
        }),
      }).then((r) => r.json())) as { id: string; input?: unknown }
      expect(created.id).toBe('s-with-input')
      expect(created.input).toEqual({ user: 'alice', level: 3 })

      const list = (await fetch(`${base}/schedules`).then((r) => r.json())) as Array<{
        id: string
        input?: unknown
      }>
      expect(list.find((s) => s.id === 's-with-input')?.input).toEqual({
        user: 'alice',
        level: 3,
      })
    } finally {
      await gw.stop()
    }
  })

  it('schedule fire dispatches the persisted input as the pipeline payload', async () => {
    const seenPayloads: unknown[] = []
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    // Inject a no-op onFire so we can observe FireContext.payload directly.
    gw.managers.triggers.setOnFire(async (ctx) => {
      seenPayloads.push(ctx.payload)
    })
    try {
      // Register with input.
      await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's-fire',
          workflowId: 'wf',
          trigger: { kind: 'manual' },
          input: { foo: 'bar' },
        }),
      }).then((r) => r.json())
      // Fire it through the manual fire endpoint.
      const fired = await fetch(`${base}/triggers/s-fire/fire`, { method: 'POST' })
      expect(fired.status).toBe(200)
      const firedBody = (await fired.json()) as { ok: boolean; status: string }
      expect(firedBody).toEqual({ ok: true, status: 'dispatched' })
      // onFire receives the persisted input as the payload.
      expect(seenPayloads).toEqual([{ foo: 'bar' }])
    } finally {
      await gw.stop()
    }
  })

  it('POST /triggers/:id/fire returns after accepting a long-running dispatch', async () => {
    let release: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    let fires = 0
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    gw.managers.triggers.setOnFire(async () => {
      fires++
      await inFlight
    })
    try {
      await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's-long',
          workflowId: 'wf',
          trigger: { kind: 'manual' },
          overlap: 'skip',
        }),
      }).then((r) => r.json())

      const first = await expectSettlesWithin(
        fetch(`${base}/triggers/s-long/fire`, { method: 'POST' }),
        100,
      )
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({ ok: true, status: 'dispatched' })
      expect(fires).toBe(1)
      expect(gw.managers.triggers.get('s-long')?.inflight).toBe(true)

      const second = await fetch(`${base}/triggers/s-long/fire`, { method: 'POST' })
      expect(second.status).toBe(409)
      release()
      await new Promise((r) => setImmediate(r))
      expect(gw.managers.triggers.get('s-long')?.inflight).toBe(false)
    } finally {
      release()
      await gw.stop()
    }
  })

  it('POST /triggers/:id/fire returns 409 when overlap=skip rejects a concurrent fire (F127)', async () => {
    let release: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    let fires = 0
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    gw.managers.triggers.setOnFire(async () => {
      fires++
      await inFlight
    })
    try {
      await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's-skip',
          workflowId: 'wf',
          trigger: { kind: 'manual' },
          overlap: 'skip',
        }),
      }).then((r) => r.json())
      // Fire 1 dispatches and blocks inside onFire (inFlight not released).
      const first = fetch(`${base}/triggers/s-skip/fire`, { method: 'POST' })
      // Allow the first fire's onFire to start so `inflight` flips true.
      await new Promise((r) => setTimeout(r, 30))
      // Fire 2 hits while fire 1 is still in flight → 409 skipped.
      const second = await fetch(`${base}/triggers/s-skip/fire`, { method: 'POST' })
      expect(second.status).toBe(409)
      const body = (await second.json()) as { statusMessage?: string; data?: { status?: string } }
      expect(body.data?.status).toBe('skipped')
      release()
      const firstRes = await first
      expect(firstRes.status).toBe(200)
      expect(fires).toBe(1)
    } finally {
      await gw.stop()
    }
  })

  it('POST /schedules with kind=queue registers when the driver is known', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const driver = new InMemoryQueueDriver()
      gw.managers.triggers.registerQueueDriver('memq', driver)

      const ok = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's-queue',
          workflowId: 'wf',
          trigger: { kind: 'queue', driver: 'memq' },
        }),
      })
      expect(ok.status).toBe(200)

      // Unknown driver surfaces as 400 with the coordinator's lastError.
      const fail = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's-q2',
          workflowId: 'wf',
          trigger: { kind: 'queue', driver: 'no-such-driver' },
        }),
      })
      expect(fail.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('POST /schedules validates required fields', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const noId = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: 'w', trigger: { kind: 'immediate' } }),
      })
      expect(noId.status).toBe(400)

      const noTrigger = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 's', workflowId: 'w' }),
      })
      expect(noTrigger.status).toBe(400)

      const badTrigger = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's',
          workflowId: 'w',
          trigger: { kind: 'interval' /* missing everyMs */ },
        }),
      })
      expect(badTrigger.status).toBe(400)

      // Default-deny: ms-graph webhook without clientState rejected
      // because Graph does not sign payloads (issue #161).
      const graphNoCs = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's',
          workflowId: 'w',
          trigger: { kind: 'webhook', path: '/h', provider: 'ms-graph' },
        }),
      })
      expect(graphNoCs.status).toBe(400)

      // Empty-string clientState treated the same as omitted.
      const graphEmptyCs = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's',
          workflowId: 'w',
          trigger: {
            kind: 'webhook',
            path: '/h',
            provider: 'ms-graph',
            clientState: '',
          },
        }),
      })
      expect(graphEmptyCs.status).toBe(400)

      // Same path with a non-empty clientState registers cleanly.
      const graphOk = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'graph-ok',
          workflowId: 'w',
          trigger: {
            kind: 'webhook',
            path: '/hooks/graph-ok',
            provider: 'ms-graph',
            clientState: 'shared',
          },
        }),
      })
      expect(graphOk.status).toBe(200)
    } finally {
      await gw.stop()
    }
  })
})

describe('Gateway HTTP POST /pipelines/:id/run', () => {
  it('runs a pipeline synchronously and returns the final state', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pl-run-'))
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await fs.writeFile(join(projectRoot, 'workflows/r.workflow.ts'), 'export default {}')

    const wf = pipeline({
      id: 'echo',
      input: z.object({ msg: z.string() }),
      steps: [
        code({
          id: 'echo-step',
          run: (ctx) => ({ echoed: (ctx.input as { msg: string }).msg.toUpperCase() }),
        }),
      ],
    })

    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      loadWorkflow: async () => wf,
      config: {
        registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
      },
    }))
    try {
      const res = await fetch(
        `${base}/pipelines/${encodeURIComponent('workflows/r.workflow.ts')}/run`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: { msg: 'hello' } }),
        },
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { runId: string; status: string; output: unknown }
      expect(body.runId).toMatch(/[a-f0-9-]{36}/)
      expect(body.status).toBe('completed')
      expect(body.output).toEqual({ echoed: 'HELLO' })
    } finally {
      await gw.stop()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('Idempotency-Key header replays the cached runId', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pl-idem-'))
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await fs.writeFile(join(projectRoot, 'workflows/r.workflow.ts'), 'export default {}')

    let calls = 0
    const wf = pipeline({
      id: 'idem',
      steps: [
        code({
          id: 'count',
          run: () => {
            calls += 1
            return { calls }
          },
        }),
      ],
    })

    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      loadWorkflow: async () => wf,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    }))
    try {
      const url = `${base}/pipelines/${encodeURIComponent('workflows/r.workflow.ts')}/run`
      const first = (await fetch(url, {
        method: 'POST',
        headers: { 'idempotency-key': 'k1' },
      }).then((r) => r.json())) as { runId: string }
      expect(calls).toBe(1)

      const second = (await fetch(url, {
        method: 'POST',
        headers: { 'idempotency-key': 'k1' },
      }).then((r) => r.json())) as { runId: string }
      // Cached: same runId, no extra invocation.
      expect(second.runId).toBe(first.runId)
      expect(calls).toBe(1)

      // A different key starts a new run.
      const third = (await fetch(url, {
        method: 'POST',
        headers: { 'idempotency-key': 'k2' },
      }).then((r) => r.json())) as { runId: string }
      expect(third.runId).not.toBe(first.runId)
      expect(calls).toBe(2)
    } finally {
      await gw.stop()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('POST /pipelines/:id/start returns immediately and the run completes asynchronously', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pl-async-'))
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await fs.writeFile(join(projectRoot, 'workflows/r.workflow.ts'), 'export default {}')

    const wf = pipeline({
      id: 'slow',
      steps: [
        code({
          id: 'sleeper',
          run: async () => {
            await new Promise((r) => setTimeout(r, 30))
            return { ok: true }
          },
        }),
      ],
    })
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      loadWorkflow: async () => wf,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    }))
    try {
      const url = `${base}/pipelines/${encodeURIComponent('workflows/r.workflow.ts')}/start`
      const started = (await fetch(url, { method: 'POST' }).then((r) => r.json())) as {
        runId: string
        status: string
      }
      expect(started.status).toBe('running')
      expect(started.runId).toMatch(/[a-f0-9-]{36}/)
      // Poll until completion.
      let final: { status: string } | null = null
      for (let i = 0; i < 50; i++) {
        const state = await gw.runStore.getRun(started.runId)
        if (state !== null && (state.status === 'completed' || state.status === 'failed')) {
          final = state
          break
        }
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(final?.status).toBe('completed')
    } finally {
      await gw.stop()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('POST /runs/:runId/resume completes a wait()-suspended run', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pl-wait-'))
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await fs.writeFile(join(projectRoot, 'workflows/r.workflow.ts'), 'export default {}')

    const wf = pipeline({
      id: 'wait-pipe',
      steps: [
        wait({ id: 'pause-here' }),
        code({
          id: 'after-resume',
          run: (ctx) => ({ resumedWith: ctx.steps['pause-here'] }),
        }),
      ],
    })

    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      loadWorkflow: async () => wf,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    }))
    try {
      const url = `${base}/pipelines/${encodeURIComponent('workflows/r.workflow.ts')}/start`
      const started = (await fetch(url, { method: 'POST' }).then((r) => r.json())) as {
        runId: string
      }
      // Wait until the runner has registered the wait().
      await new Promise((r) => setTimeout(r, 30))

      const resumeRes = await fetch(`${base}/runs/${started.runId}/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ output: { signal: 'go' } }),
      })
      expect(resumeRes.status).toBe(200)
      expect(await resumeRes.json()).toEqual({ resumed: true, runId: started.runId })

      // Poll for completion.
      let final: { status: string; output: unknown } | null = null
      for (let i = 0; i < 50; i++) {
        const state = await gw.runStore.getRun(started.runId)
        if (state !== null && state.status === 'completed') {
          final = state
          break
        }
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(final?.status).toBe('completed')
      expect(final?.output).toMatchObject({ resumedWith: { signal: 'go' } })
    } finally {
      await gw.stop()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('POST /runs/:runId/resume 404s for unknown runId', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const res = await fetch(`${base}/runs/missing/resume`, {
        method: 'POST',
        body: '{}',
      })
      expect(res.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })

  it('returns 501 when no workflow loader is configured', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pl-run-'))
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await fs.writeFile(join(projectRoot, 'workflows/r.workflow.ts'), 'export default {}')

    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    }))
    try {
      const res = await fetch(
        `${base}/pipelines/${encodeURIComponent('workflows/r.workflow.ts')}/run`,
        { method: 'POST' },
      )
      expect(res.status).toBe(501)
    } finally {
      await gw.stop()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

describe('Gateway HTTP OpenAI-compat surface', () => {
  it('POST /v1/chat/completions translates messages to a pipeline run and wraps output', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'skelm-oai-'))
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await fs.writeFile(join(projectRoot, 'workflows/r.workflow.ts'), 'export default {}')

    const wf = pipeline({
      id: 'echo',
      steps: [
        code({
          id: 'echo',
          run: (ctx) => {
            const msgs = (ctx.input as { messages?: Array<{ content: string }> }).messages ?? []
            const last = msgs[msgs.length - 1]?.content ?? ''
            return { content: `you said: ${last}` }
          },
        }),
      ],
    })

    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      loadWorkflow: async () => wf,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    }))
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'workflows/r.workflow.ts',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        object: string
        choices: Array<{ message: { role: string; content: string }; finish_reason: string }>
      }
      expect(body.object).toBe('chat.completion')
      expect(body.choices).toHaveLength(1)
      expect(body.choices[0]?.message.role).toBe('assistant')
      expect(body.choices[0]?.message.content).toBe('you said: hello')
      expect(body.choices[0]?.finish_reason).toBe('stop')
    } finally {
      await gw.stop()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('POST /v1/chat/completions 404s when the named model has no pipeline', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'nothing', messages: [] }),
      })
      expect(res.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })

  it('POST /v1/responses accepts string input and produces an output_text part', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'skelm-oai-'))
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await fs.writeFile(join(projectRoot, 'workflows/r.workflow.ts'), 'export default {}')

    const wf = pipeline({
      id: 'mirror',
      steps: [
        code({
          id: 'mirror',
          run: (ctx) => {
            const msgs = (ctx.input as { messages: Array<{ content: string }> }).messages
            return { content: `mirror: ${msgs[0]?.content}` }
          },
        }),
      ],
    })
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      loadWorkflow: async () => wf,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    }))
    try {
      const res = await fetch(`${base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'workflows/r.workflow.ts', input: 'hi' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        object: string
        status: string
        output: Array<{ content: Array<{ type: string; text: string }> }>
      }
      expect(body.object).toBe('response')
      expect(body.status).toBe('completed')
      expect(body.output[0]?.content[0]?.text).toBe('mirror: hi')
    } finally {
      await gw.stop()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

describe('Gateway HTTP /pipelines', () => {
  it('GET /pipelines lists registry entries', async () => {
    // Project with a workflow file the registry can discover.
    const projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pl-proj-'))
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await fs.writeFile(
      join(projectRoot, 'workflows/hello.workflow.mts'),
      'export default { id: "hello", steps: [] }',
    )

    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {
        registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
      },
    }))
    try {
      const list = (await fetch(`${base}/pipelines`).then((r) => r.json())) as Array<{
        id: string
      }>
      expect(list.map((p) => p.id)).toEqual(['workflows/hello.workflow.mts'])
    } finally {
      await gw.stop()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('GET /pipelines/:id returns the serialized graph when a loader is configured', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pl-proj-'))
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await fs.writeFile(join(projectRoot, 'workflows/x.workflow.ts'), 'export default {}')

    const wf = pipeline({
      id: 'demo',
      description: 'a demo pipeline',
      input: z.object({ name: z.string() }),
      output: z.object({ ok: z.boolean() }),
      steps: [
        code({ id: 'first', run: () => ({}) }),
        parallel({
          id: 'fan-out',
          steps: [code({ id: 'a', run: () => ({}) }), code({ id: 'b', run: () => ({}) })],
        }),
      ],
    })

    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      loadWorkflow: async () => wf,
      config: {
        registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
      },
    }))
    try {
      const detail = (await fetch(
        `${base}/pipelines/${encodeURIComponent('workflows/x.workflow.ts')}`,
      ).then((r) => r.json())) as {
        id: string
        description?: string
        graph: { steps: Array<{ id: string; kind: string; children?: Array<{ id: string }> }> }
        input: unknown
        output: unknown
      }
      expect(detail.id).toBe('demo')
      expect(detail.description).toBe('a demo pipeline')
      expect(detail.graph.steps.map((s) => s.kind)).toEqual(['code', 'parallel'])
      expect(detail.graph.steps[1]?.children?.map((c) => c.id)).toEqual(['a', 'b'])
      // Zod schemas are converted via z.toJSONSchema (Zod 4+).
      const input = detail.input as {
        type?: string
        properties?: Record<string, unknown>
        required?: string[]
      }
      expect(input.type).toBe('object')
      expect(input.properties?.name).toBeDefined()
      expect(input.required).toEqual(['name'])
      const output = detail.output as { type?: string; properties?: Record<string, unknown> }
      expect(output.type).toBe('object')
      expect(output.properties?.ok).toBeDefined()
    } finally {
      await gw.stop()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('GET /pipelines/:id returns metadata only when no loader is configured', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pl-proj-'))
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await fs.writeFile(join(projectRoot, 'workflows/y.workflow.ts'), 'export default {}')

    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      // no loadWorkflow
      config: {
        registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
      },
    }))
    try {
      const detail = (await fetch(
        `${base}/pipelines/${encodeURIComponent('workflows/y.workflow.ts')}`,
      ).then((r) => r.json())) as { id: string; graph: unknown; input: unknown; output: unknown }
      expect(detail.id).toBe('workflows/y.workflow.ts')
      expect(detail.graph).toBeNull()
      expect(detail.input).toBeNull()
      expect(detail.output).toBeNull()
    } finally {
      await gw.stop()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('GET /pipelines/:id 404s for unknown ids', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const res = await fetch(`${base}/pipelines/${encodeURIComponent('does/not/exist.ts')}`)
      expect(res.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })
})

describe('Gateway HTTP /metrics', () => {
  it('404s when metrics are not enabled', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      const res = await fetch(`${base}/metrics`)
      expect(res.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })

  it('renders Prometheus metrics when enabled', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      enableMetrics: true,
      httpPort: port,
      config: {},
    }))
    try {
      gw.metrics?.recordTriggerFire('cron-x')
      const res = await fetch(`${base}/metrics`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')
      const body = await res.text()
      expect(body).toContain('skelm_runs_started_total 0')
      expect(body).toContain('skelm_trigger_fires_total{trigger="cron-x"} 1')
      expect(body).toContain('skelm_approvals_pending 0')
    } finally {
      await gw.stop()
    }
  })
})

describe('Gateway HTTP /debug breakpoints', () => {
  it('add, list, delete breakpoints; list and release paused runs', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
    }))
    try {
      let listed = (await fetch(`${base}/debug/breakpoints`).then((r) => r.json())) as {
        breakpoints: string[]
      }
      expect(listed.breakpoints).toEqual([])

      const added = await fetch(`${base}/debug/breakpoints`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stepId: 'agent-1' }),
      }).then((r) => r.json())
      expect(added).toEqual({ added: 'agent-1' })

      listed = (await fetch(`${base}/debug/breakpoints`).then((r) => r.json())) as {
        breakpoints: string[]
      }
      expect(listed.breakpoints).toEqual(['agent-1'])

      // Simulate a paused run by calling pause directly; release via HTTP.
      const pausePromise = gw.breakpoints.pause({
        runId: 'run-1',
        stepId: 'agent-1',
        kind: 'agent',
      })
      const paused = (await fetch(`${base}/debug/runs`).then((r) => r.json())) as {
        paused: Array<{ runId: string; stepId: string }>
      }
      expect(paused.paused).toHaveLength(1)
      expect(paused.paused[0]?.runId).toBe('run-1')

      const released = await fetch(`${base}/debug/runs/run-1/release`, { method: 'POST' }).then(
        (r) => r.json(),
      )
      expect(released).toEqual({ released: 'run-1' })
      // Pause promise should now resolve.
      await pausePromise

      // Releasing again 404s.
      const second = await fetch(`${base}/debug/runs/run-1/release`, { method: 'POST' })
      expect(second.status).toBe(404)

      // Removing a breakpoint.
      const removed = await fetch(`${base}/debug/breakpoints/agent-1`, { method: 'DELETE' })
      expect(removed.status).toBe(200)
      expect(await removed.json()).toEqual({ removed: 'agent-1' })

      // Removing again 404s.
      const removed2 = await fetch(`${base}/debug/breakpoints/agent-1`, { method: 'DELETE' })
      expect(removed2.status).toBe(404)

      // POST without stepId is 400.
      const bad = await fetch(`${base}/debug/breakpoints`, { method: 'POST', body: '{}' })
      expect(bad.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })
})

describe('Gateway runStore', () => {
  it('constructs a SqliteRunStore at <stateDir>/runs.sqlite by default', async () => {
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      config: {}, // no storage override → default to sqlite at stateDir
    })
    await gw.start()
    try {
      expect(gw.runStore).toBeDefined()
      // Constructing the store creates the file lazily; touch it via getRun.
      await gw.runStore.getRun('does-not-exist')
      const stat = await fs.stat(join(stateDir, 'runs.sqlite'))
      expect(stat.isFile()).toBe(true)
    } finally {
      await gw.stop()
    }
  })

  it('throws when accessed after stop()', async () => {
    const gw = new Gateway({ stateDir, watchRegistries: false })
    await gw.start()
    await gw.stop()
    expect(() => gw.runStore).toThrow(/runStore is not available/)
  })

  it('uses a caller-supplied RunStore when options.runStore is set', async () => {
    const custom = new MemoryRunStore()
    await custom.putRun({
      runId: 'pre-existing',
      pipelineId: 'p',
      status: 'completed',
      input: {},
      steps: [],
      output: undefined,
      error: undefined,
      startedAt: 1,
      completedAt: 2,
    })
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      runStore: custom,
    })
    await gw.start()
    try {
      // The injected store is identity-equal to the gateway's runStore;
      // the pre-existing run is visible.
      expect(gw.runStore).toBe(custom)
      const found = await gw.runStore.getRun('pre-existing')
      expect(found?.runId).toBe('pre-existing')
    } finally {
      await gw.stop()
    }
  })
})

it('DELETE /schedules/:id unregisters a schedule; 404 for unknown', async () => {
  const { gw, base } = await bootGatewayWithRetry(async (port) => ({
    stateDir,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    config: {},
  }))
  try {
    await fetch(`${base}/schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'del-me',
        workflowId: 'wf',
        trigger: { kind: 'cron', expression: '0 * * * *' },
      }),
    })

    // Should exist now
    const list1 = (await fetch(`${base}/schedules`).then((r) => r.json())) as Array<{
      id: string
    }>
    expect(list1.map((s) => s.id)).toContain('del-me')

    // Delete it
    const del = await fetch(`${base}/schedules/del-me`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await del.json()).toMatchObject({ ok: true, id: 'del-me' })

    // Gone from list
    const list2 = (await fetch(`${base}/schedules`).then((r) => r.json())) as Array<{
      id: string
    }>
    expect(list2.map((s) => s.id)).not.toContain('del-me')

    // 404 for unknown
    const notFound = await fetch(`${base}/schedules/no-such-id`, { method: 'DELETE' })
    expect(notFound.status).toBe(404)
  } finally {
    await gw.stop()
  }
})
