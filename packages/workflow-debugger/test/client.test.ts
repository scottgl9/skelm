import { describe, expect, it } from 'vitest'
import { GatewayDebugHttpClient } from '../src/client.js'

const TOKEN = ['sk', 'gw', '0123456789abcdef'].join('-')

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('GatewayDebugHttpClient', () => {
  it('sends a bearer header and reads run + events + audit + artifacts', async () => {
    const seen: Array<{ url: string; auth: string | null; method: string }> = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      seen.push({ url, auth: headers.get('authorization'), method: init?.method ?? 'GET' })
      if (url.endsWith('/runs/r1')) return jsonResponse({ pipelineId: 'demo', status: 'failed' })
      if (url.endsWith('/runs/r1/events')) {
        return jsonResponse({
          runId: 'r1',
          events: [{ type: 'run.failed', runId: 'r1', at: 1, seq: 1 }],
        })
      }
      if (url.includes('/audit')) {
        return jsonResponse({
          entries: [{ seq: 1, actor: 'gateway', action: 'permission.denied', data: {} }],
        })
      }
      if (url.endsWith('/artifacts')) {
        return jsonResponse({ artifacts: [{ id: 'a1', name: 'x', mimeType: 'application/json' }] })
      }
      return jsonResponse({})
    }) as typeof globalThis.fetch

    const client = new GatewayDebugHttpClient({ url: 'http://gw', token: TOKEN, fetch: fetchImpl })
    expect(await client.getRun('r1')).toEqual({ pipelineId: 'demo', status: 'failed' })
    expect((await client.getEvents('r1')).length).toBe(1)
    expect((await client.getAudit('r1')).length).toBe(1)
    expect((await client.getArtifacts('r1')).length).toBe(1)
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true)
    expect(seen.every((s) => s.method === 'GET')).toBe(true)
  })

  it('only ever calls the apply route with dryRun: true', async () => {
    let sentBody: unknown
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body))
      return jsonResponse({ ok: true, applied: false, dryRun: true, diff: 'd' })
    }) as typeof globalThis.fetch
    const client = new GatewayDebugHttpClient({ url: 'http://gw', token: TOKEN, fetch: fetchImpl })
    const res = await client.applyGraphEditsDryRun('demo', [{ kind: 'removeStep', stepId: 's' }])
    expect((sentBody as { dryRun: boolean }).dryRun).toBe(true)
    expect(res.applied).toBe(false)
    expect(res.dryRun).toBe(true)
  })

  it('throws on non-2xx', async () => {
    const fetchImpl = (async () =>
      new Response('nope', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      })) as typeof globalThis.fetch
    const client = new GatewayDebugHttpClient({ url: 'http://gw', fetch: fetchImpl })
    await expect(client.getRun('r1')).rejects.toThrow(/401/)
  })
})
