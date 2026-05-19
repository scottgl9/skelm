import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/index.js'
import { pickFreePort } from './utils/pick-free-port.js'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-webhook-provider-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

function slackSignature(rawBody: string, timestamp: string, secret: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`
}

describe('webhook providers', () => {
  it('responds to Slack URL verification without firing the pipeline', async () => {
    const port = await pickFreePort()
    const proxyPort = await pickFreePort()
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      httpProxyPort: proxyPort,
      config: {},
    })
    await gw.start()
    try {
      const fired: string[] = []
      gw.managers.triggers.setOnFire(async (ctx) => {
        fired.push(ctx.triggerId)
      })
      gw.managers.triggers.register({
        kind: 'webhook',
        id: 'slack-hook',
        workflowId: 'wf',
        path: '/hooks/slack',
        provider: 'slack',
        secret: 'signing-secret',
      })

      const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'abc123' })
      const timestamp = String(Math.floor(Date.now() / 1000))
      const res = await fetch(`http://127.0.0.1:${port}/hooks/slack`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': slackSignature(rawBody, timestamp, 'signing-secret'),
        },
        body: rawBody,
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ challenge: 'abc123' })
      expect(fired).toEqual([])
    } finally {
      await gw.stop()
    }
  })

  it('verifies Slack request signatures and rejects invalid or replayed requests', async () => {
    const port = await pickFreePort()
    const proxyPort = await pickFreePort()
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      httpProxyPort: proxyPort,
      config: {},
    })
    await gw.start()
    try {
      const fired: string[] = []
      const payloads: unknown[] = []
      gw.managers.triggers.setOnFire(async (ctx) => {
        fired.push(ctx.triggerId)
        payloads.push(ctx.payload)
      })
      gw.managers.triggers.register({
        kind: 'webhook',
        id: 'slack-events',
        workflowId: 'wf',
        path: '/hooks/slack-events',
        provider: 'slack',
        secret: 'signing-secret',
      })

      const rawBody = JSON.stringify({ type: 'event_callback', event: { type: 'message' } })
      const freshTimestamp = String(Math.floor(Date.now() / 1000))
      const ok = await fetch(`http://127.0.0.1:${port}/hooks/slack-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': freshTimestamp,
          'x-slack-signature': slackSignature(rawBody, freshTimestamp, 'signing-secret'),
        },
        body: rawBody,
      })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ ok: true, triggerId: 'slack-events' })

      const invalid = await fetch(`http://127.0.0.1:${port}/hooks/slack-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': freshTimestamp,
          'x-slack-signature': 'v0=deadbeef',
        },
        body: rawBody,
      })
      expect(invalid.status).toBe(401)

      const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301)
      const replay = await fetch(`http://127.0.0.1:${port}/hooks/slack-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': staleTimestamp,
          'x-slack-signature': slackSignature(rawBody, staleTimestamp, 'signing-secret'),
        },
        body: rawBody,
      })
      expect(replay.status).toBe(401)
      expect(fired).toEqual(['slack-events'])
      // The Slack-signed body must be parsed back into the event envelope
      // verbatim — a regression in raw-body handling or signature parsing
      // would show up here as a JSON shape mismatch, not just a wrong count.
      expect(payloads).toHaveLength(1)
      expect((payloads[0] as { body?: unknown }).body).toEqual({
        type: 'event_callback',
        event: { type: 'message' },
      })
    } finally {
      await gw.stop()
    }
  })

  it('responds to the MS Graph validation token without firing the pipeline', async () => {
    const port = await pickFreePort()
    const proxyPort = await pickFreePort()
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      httpProxyPort: proxyPort,
      config: {},
    })
    await gw.start()
    try {
      const fired: string[] = []
      gw.managers.triggers.setOnFire(async (ctx) => {
        fired.push(ctx.triggerId)
      })
      gw.managers.triggers.register({
        kind: 'webhook',
        id: 'graph-hook',
        workflowId: 'wf',
        path: '/hooks/graph',
        provider: 'ms-graph',
      })

      const res = await fetch(
        `http://127.0.0.1:${port}/hooks/graph?validationToken=plain-text-token`,
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')
      expect(await res.text()).toBe('plain-text-token')
      expect(fired).toEqual([])
    } finally {
      await gw.stop()
    }
  })
})
