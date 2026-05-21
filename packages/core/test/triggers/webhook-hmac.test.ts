import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWebhookTrigger } from '../../src/triggers/webhook.js'

// Adversarial coverage for the generic webhook trigger's HMAC verification.
// Per AGENTS.md security tenet: a webhook trigger with a configured secret
// must reject anything that fails strict signature + replay-window checks.

let trigger: ReturnType<typeof createWebhookTrigger> | null = null
let port = 4310

async function startTrigger(opts: { secret?: string; replayWindowSeconds?: number } = {}): Promise<{
  port: number
  path: string
}> {
  port++
  trigger = createWebhookTrigger(`hmac-${port}`, 'HMAC Test')
  await trigger.initialize({
    id: `hmac-${port}`,
    port,
    path: '/hook',
    ...(opts.secret !== undefined && { secret: opts.secret }),
    ...(opts.replayWindowSeconds !== undefined && {
      replayWindowSeconds: opts.replayWindowSeconds,
    }),
  })
  await trigger.start()
  return { port, path: '/hook' }
}

function sign(secret: string, timestampSec: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex')}`
}

async function post(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
  return { status: res.status, text: await res.text() }
}

afterEach(async () => {
  if (trigger !== null) {
    await trigger.stop().catch(() => {})
    trigger = null
  }
})

describe('WebhookTrigger HMAC verification', () => {
  it('accepts a request with a valid signature + fresh timestamp', async () => {
    const secret = 'shhh'
    const { port, path } = await startTrigger({ secret })
    const body = '{"hello":"world"}'
    const ts = Math.floor(Date.now() / 1000)
    const res = await post(port, path, body, {
      'x-webhook-signature': sign(secret, ts, body),
      'x-webhook-timestamp': String(ts),
    })
    expect(res.status).toBe(200)
  })

  it('rejects when the signature header is missing', async () => {
    const { port, path } = await startTrigger({ secret: 's' })
    const res = await post(port, path, '{}', { 'x-webhook-timestamp': '1' })
    expect(res.status).toBe(401)
  })

  it('rejects when the timestamp header is missing', async () => {
    const secret = 's'
    const { port, path } = await startTrigger({ secret })
    const ts = Math.floor(Date.now() / 1000)
    const res = await post(port, path, '{}', {
      'x-webhook-signature': sign(secret, ts, '{}'),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a stale timestamp outside the replay window', async () => {
    const secret = 's'
    const { port, path } = await startTrigger({ secret, replayWindowSeconds: 60 })
    const stale = Math.floor(Date.now() / 1000) - 3600
    const body = '{}'
    const res = await post(port, path, body, {
      'x-webhook-signature': sign(secret, stale, body),
      'x-webhook-timestamp': String(stale),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a signature computed with the wrong secret', async () => {
    const secret = 'correct'
    const { port, path } = await startTrigger({ secret })
    const ts = Math.floor(Date.now() / 1000)
    const body = '{}'
    const res = await post(port, path, body, {
      'x-webhook-signature': sign('wrong', ts, body),
      'x-webhook-timestamp': String(ts),
    })
    expect(res.status).toBe(401)
  })

  it('rejects when the body is tampered after signing', async () => {
    const secret = 's'
    const { port, path } = await startTrigger({ secret })
    const ts = Math.floor(Date.now() / 1000)
    const signedBody = '{"a":1}'
    const tamperedBody = '{"a":2}'
    const res = await post(port, path, tamperedBody, {
      'x-webhook-signature': sign(secret, ts, signedBody),
      'x-webhook-timestamp': String(ts),
    })
    expect(res.status).toBe(401)
  })

  it('rejects payloads larger than maxBodyBytes', async () => {
    const { port, path } = await startTrigger()
    const huge = 'x'.repeat(2_097_152) // 2 MiB > 1 MiB default
    const res = await post(port, path, huge)
    expect(res.status).toBe(413)
  })
})

describe('WebhookTrigger unsigned mode (no secret configured)', () => {
  beforeEach(() => {
    trigger = null
  })

  it('accepts requests without any signature when secret is not set', async () => {
    const { port, path } = await startTrigger()
    const res = await post(port, path, '{"ok":true}')
    expect(res.status).toBe(200)
  })
})
