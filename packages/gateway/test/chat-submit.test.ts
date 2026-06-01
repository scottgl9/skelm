import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRemoteTriggerSource } from '@skelm/integrations'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bootGatewayWithRetry } from './utils/boot-gateway.js'

// POST /v1/chat/:sourceId/submit. A headless remote source is registered
// directly and started with an echo onMessage that drives onResult, so the
// route is exercised without a real workflow turn. Both chat transports
// (`tui` and `web`) are accepted; the dev-CORS affordance is default-off.

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-chat-submit-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

describe('POST /v1/chat/:sourceId/submit', () => {
  it('returns the reply for a registered tui-transport source', async () => {
    const { gw, base } = await bootGatewayWithRetry((port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
    }))
    const src = createRemoteTriggerSource({ transport: 'tui' })
    gw.managers.triggers.registerQueueDriver('tui', src)
    src.start({
      onMessage: async (p) => src.onEvent(p, { type: 'run.started', runId: 'run-x', at: 0 }),
    })
    try {
      const res = await fetch(`${base}/v1/chat/tui/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', text: 'hi' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ runId: 'run-x' })

      const unknown = await fetch(`${base}/v1/chat/nope/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', text: 'hi' }),
      })
      expect(unknown.status).toBe(404)

      const missing = await fetch(`${base}/v1/chat/tui/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1' }),
      })
      expect(missing.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('accepts a web-transport source', async () => {
    const { gw, base } = await bootGatewayWithRetry((port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
    }))
    const src = createRemoteTriggerSource({ transport: 'web' })
    gw.managers.triggers.registerQueueDriver('web', src)
    src.start({
      onMessage: async (p) => src.onEvent(p, { type: 'run.started', runId: 'run-w', at: 0 }),
    })
    try {
      const res = await fetch(`${base}/v1/chat/web/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'web-1', text: 'hi' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ runId: 'run-w' })
    } finally {
      await gw.stop()
    }
  })
})

describe('dev CORS affordance (SKELM_DEV_CORS)', () => {
  const prev = process.env.SKELM_DEV_CORS

  afterEach(() => {
    // Must truly unset: `process.env.X = undefined` stores the string "undefined",
    // which the gateway's SKELM_DEV_CORS check would read as enabled.
    // biome-ignore lint/performance/noDelete: env vars must be deleted, not stringified
    if (prev === undefined) delete process.env.SKELM_DEV_CORS
    else process.env.SKELM_DEV_CORS = prev
  })

  it('emits no CORS header by default', async () => {
    // biome-ignore lint/performance/noDelete: env vars must be deleted, not stringified
    delete process.env.SKELM_DEV_CORS
    const { gw, base } = await bootGatewayWithRetry((port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
    }))
    try {
      const res = await fetch(`${base}/health`, { headers: { origin: 'http://example.test' } })
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      await gw.stop()
    }
  })

  it('reflects the request Origin and answers preflight when enabled', async () => {
    process.env.SKELM_DEV_CORS = '1'
    const { gw, base } = await bootGatewayWithRetry((port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
    }))
    try {
      const preflight = await fetch(`${base}/v1/chat/web/submit`, {
        method: 'OPTIONS',
        headers: { origin: 'http://example.test' },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe('http://example.test')

      // A normal request carries the header too (the SSE stream relies on this).
      const res = await fetch(`${base}/health`, { headers: { origin: 'http://example.test' } })
      expect(res.headers.get('access-control-allow-origin')).toBe('http://example.test')
    } finally {
      await gw.stop()
    }
  })
})
