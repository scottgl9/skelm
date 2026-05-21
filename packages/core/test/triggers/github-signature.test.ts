import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitHubTrigger } from '../../src/triggers/github.js'

// Adversarial coverage for the GitHub webhook trigger's signature
// verification. Per AGENTS.md security tenet: when a secret is configured,
// missing or invalid signatures must reject (fail-closed). The previous
// `config.secret && signature` short-circuit silently accepted unsigned
// requests when only the header was missing.

let trigger: ReturnType<typeof createGitHubTrigger> | null = null
let port = 4410

async function startTrigger(opts: { secret?: string } = {}): Promise<{
  port: number
  path: string
}> {
  port++
  trigger = createGitHubTrigger(`gh-${port}`, 'GitHub Test')
  await trigger.initialize({
    id: `gh-${port}`,
    port,
    path: '/hook',
    ...(opts.secret !== undefined && { secret: opts.secret }),
  })
  await trigger.start()
  return { port, path: '/hook' }
}

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

async function post(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', ...headers },
    body,
  })
  return { status: res.status }
}

afterEach(async () => {
  if (trigger !== null) {
    await trigger.stop().catch(() => {})
    trigger = null
  }
})

describe('GitHubTrigger signature verification', () => {
  it('accepts a valid HMAC signature', async () => {
    const secret = 's'
    const { port, path } = await startTrigger({ secret })
    const body = '{"ok":true}'
    const res = await post(port, path, body, {
      'x-hub-signature-256': sign(secret, body),
    })
    expect(res.status).toBe(200)
  })

  it('rejects when the signature header is missing but a secret is configured (fail-closed)', async () => {
    const { port, path } = await startTrigger({ secret: 's' })
    const res = await post(port, path, '{}', {})
    expect(res.status).toBe(401)
  })

  it('rejects when the signature is computed with the wrong secret', async () => {
    const { port, path } = await startTrigger({ secret: 'correct' })
    const body = '{}'
    const res = await post(port, path, body, {
      'x-hub-signature-256': sign('wrong', body),
    })
    expect(res.status).toBe(401)
  })

  it('rejects when the body is tampered after signing', async () => {
    const secret = 's'
    const { port, path } = await startTrigger({ secret })
    const res = await post(port, path, '{"x":2}', {
      'x-hub-signature-256': sign(secret, '{"x":1}'),
    })
    expect(res.status).toBe(401)
  })

  it('accepts unsigned requests when no secret is configured (unsigned mode)', async () => {
    const { port, path } = await startTrigger()
    const res = await post(port, path, '{}')
    expect(res.status).toBe(200)
  })
})
