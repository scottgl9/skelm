import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRemoteTriggerSource } from '@skelm/integrations'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bootGatewayWithRetry } from './utils/boot-gateway.js'

// POST /v1/tui/:sourceId/submit. A headless remote source is registered
// directly and started with an echo onMessage that drives onResult, so the
// route is exercised without a real workflow turn.

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-tui-submit-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

describe('POST /v1/tui/:sourceId/submit', () => {
  it('returns the reply for a registered TUI source', async () => {
    const { gw, base } = await bootGatewayWithRetry((port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
    }))
    const src = createRemoteTriggerSource()
    gw.managers.triggers.registerQueueDriver('tui', src)
    src.start({
      onMessage: async (p) => src.onResult(p, { reply: `echo: ${(p as { text: string }).text}` }),
    })
    try {
      const res = await fetch(`${base}/v1/tui/tui/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', text: 'hi' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ reply: 'echo: hi' })

      const unknown = await fetch(`${base}/v1/tui/nope/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', text: 'hi' }),
      })
      expect(unknown.status).toBe(404)

      const missing = await fetch(`${base}/v1/tui/tui/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1' }),
      })
      expect(missing.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })
})
