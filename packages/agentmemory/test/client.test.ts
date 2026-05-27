import { describe, expect, it, vi } from 'vitest'
import { AgentmemoryClient } from '../src/client.js'
import { AgentmemoryError } from '../src/errors.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('AgentmemoryClient', () => {
  it('POSTs /observe with bearer auth and JSON body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({
      url: 'http://localhost:3111/',
      secret: 's3cret',
      fetch: fetchMock,
    })
    await client.observe({
      hookType: 'post_tool_use',
      sessionId: 'sess',
      project: '/p',
      cwd: '/p',
      timestamp: '2026-01-01T00:00:00.000Z',
      data: { tool_name: 'fs_read' },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe('http://localhost:3111/agentmemory/observe')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer s3cret')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toMatchObject({
      hookType: 'post_tool_use',
      sessionId: 'sess',
    })
  })

  it('omits Authorization when no secret is set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://localhost:3111', fetch: fetchMock })
    await client.endSession({ sessionId: 's' })
    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('throws AgentmemoryError on non-2xx status with parsed message', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('boom', { status: 500 }),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    await expect(client.smartSearch({ query: 'q' })).rejects.toMatchObject({
      name: 'AgentmemoryError',
      status: 500,
    })
  })

  it('wraps network failures in AgentmemoryError with cause', async () => {
    const cause = new Error('econnrefused')
    const fetchMock = vi.fn(async () => {
      throw cause
    }) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    await expect(
      client.startSession({ sessionId: 's', project: '/p', cwd: '/p' }),
    ).rejects.toBeInstanceOf(AgentmemoryError)
  })

  it('normalizes smart-search results from the wire shape', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        hits: [
          { id: '1', title: 'A', content: 'a', score: 0.9, concepts: ['x'] },
          { id: '2', title: 'B', narrative: 'b' },
        ],
      }),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const res = await client.smartSearch({ query: 'q', limit: 2 })
    expect(res.hits).toHaveLength(2)
    expect(res.hits[0]).toMatchObject({ id: '1', title: 'A', content: 'a', score: 0.9 })
    expect(res.hits[1]).toMatchObject({ id: '2', title: 'B', content: 'b' })
  })

  it('returns empty hits when the server returns a non-object body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(null)) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const res = await client.smartSearch({ query: 'q' })
    expect(res.hits).toEqual([])
  })

  it('times out after timeoutMs and surfaces an AgentmemoryError', async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined
      return await new Promise<Response>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        }
      })
    }) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', timeoutMs: 5, fetch: fetchMock })
    await expect(client.health()).rejects.toBeInstanceOf(AgentmemoryError)
  })
})
