import { afterEach, describe, expect, it } from 'vitest'
import { createGitHubTrigger } from '../../src/triggers/github.js'

// The GitHub webhook listener binds a public port and buffers the body before
// signature verification, so an oversized body must be rejected (413) up front
// rather than buffered unbounded — an unauthenticated memory-exhaustion guard.

let trigger: ReturnType<typeof createGitHubTrigger> | null = null
let port = 4480

async function start(maxBodyBytes?: number): Promise<number> {
  port++
  trigger = createGitHubTrigger(`gh-cap-${port}`, 'GitHub Cap Test')
  await trigger.initialize({
    id: `gh-cap-${port}`,
    port,
    path: '/hook',
    ...(maxBodyBytes !== undefined && { maxBodyBytes }),
  })
  await trigger.start()
  return port
}

async function post(p: number, body: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${p}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
    body,
  })
  return res.status
}

afterEach(async () => {
  if (trigger !== null) {
    await trigger.stop().catch(() => {})
    trigger = null
  }
})

describe('GitHubTrigger body-size cap', () => {
  it('rejects a body over maxBodyBytes with 413', async () => {
    const p = await start(64)
    expect(await post(p, JSON.stringify({ pad: 'x'.repeat(500) }))).toBe(413)
  })

  it('accepts a body within the cap', async () => {
    const p = await start(1024)
    // No secret configured → 200 once the (small) body is read.
    expect(await post(p, JSON.stringify({ ok: true }))).toBe(200)
  })
})
