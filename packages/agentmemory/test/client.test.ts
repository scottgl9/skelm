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
    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('throws AgentmemoryError on non-2xx status with parsed message', async () => {
    const fetchMock = vi.fn(
      async () => new Response('boom', { status: 500 }),
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

  it('GETs /health and returns the parsed body', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, version: '0.9.0' }),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const res = await client.health()
    expect(res).toEqual({ ok: true, version: '0.9.0' })
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe('http://x/agentmemory/health')
    expect(init.method).toBe('GET')
  })

  it('POSTs /session/start and /session/end with their request bodies', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    await client.startSession({ sessionId: 's', project: '/p', cwd: '/p', model: 'qwen' })
    await client.endSession({ sessionId: 's' })
    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, RequestInit]
    >
    expect(calls[0]?.[0]).toBe('http://x/agentmemory/session/start')
    expect(JSON.parse(calls[0]?.[1].body as string)).toMatchObject({
      sessionId: 's',
      model: 'qwen',
    })
    expect(calls[1]?.[0]).toBe('http://x/agentmemory/session/end')
  })

  it('POSTs /context with sessionId and normalizes the upstream context/tokens shape', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ context: 'ctx', blocks: 1, tokens: 42 }),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const res = await client.context({
      sessionId: 's',
      project: '/p',
      query: 'q',
      token_budget: 100,
    })
    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as RequestInit
    expect(JSON.parse(init.body as string)).toMatchObject({ sessionId: 's', project: '/p' })
    expect(res).toEqual({ text: 'ctx', tokenEstimate: 42 })
  })

  it('POSTs /remember and reads the id from the memory envelope', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ memory: { id: 'mem_abc', content: 'C' } }),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const res = await client.save({ project: '/p', title: 'T', content: 'C', concepts: ['a'] })
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe('http://x/agentmemory/remember')
    expect(JSON.parse(init.body as string)).toMatchObject({ title: 'T', content: 'C' })
    expect(res).toEqual({ id: 'mem_abc' })
  })

  it('GETs /memories and maps the memories[] envelope to hits', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ memories: [{ id: 'mem_1', title: 'A', content: 'a', concepts: ['x'] }] }),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const res = await client.recall({ project: '/p', limit: 5 })
    const url = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toBe('http://x/agentmemory/memories?project=%2Fp&limit=5')
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0]).toMatchObject({ id: 'mem_1', title: 'A', content: 'a' })
  })

  it('maps smart-search obsId/title (compact mode, no content) onto hits', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        mode: 'compact',
        results: [{ obsId: 'mem_9', title: 'Bluefin-7', score: 0.5 }],
      }),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const res = await client.smartSearch({ query: 'codename' })
    expect(res.hits[0]).toMatchObject({ id: 'mem_9', title: 'Bluefin-7', content: 'Bluefin-7' })
  })

  it('GETs /sessions with query params and normalizes the list', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        sessions: [{ id: 's1', title: 'First', started_at: 10, highlights: ['x'] }],
      }),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const res = await client.sessions({ project: '/p', limit: 3 })
    const url = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toBe('http://x/agentmemory/sessions?project=%2Fp&limit=3')
    expect(res.sessions[0]).toEqual({
      id: 's1',
      title: 'First',
      startedAt: 10,
      highlights: ['x'],
    })
  })

  it('handles a bare-array /sessions response', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([{ session_id: 's2' }]),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const res = await client.sessions({})
    expect(res.sessions).toEqual([{ id: 's2' }])
  })

  it('POSTs /graph/query and normalizes nodes and edges', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        nodes: [{ id: 'n1', name: 'auth', kind: 'concept' }],
        edges: [{ source: 'n1', target: 'n2', relation: 'uses' }],
      }),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const res = await client.graphQuery({ project: '/p', query: 'auth' })
    expect(res.nodes[0]).toEqual({ id: 'n1', label: 'auth', kind: 'concept' })
    expect(res.edges[0]).toEqual({ from: 'n1', to: 'n2', relation: 'uses' })
  })
})
