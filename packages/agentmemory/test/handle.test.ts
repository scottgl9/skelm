import type { AgentmemoryOperation, EnforceDecision } from '@skelm/core'
import { describe, expect, it, vi } from 'vitest'
import { AgentmemoryClient } from '../src/client.js'
import { createAgentmemoryHandle } from '../src/handle.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function allowAll(): EnforceDecision {
  return { allow: true }
}

function denyAll(): EnforceDecision {
  return { allow: false, reason: 'not-in-allowlist', dimension: 'agentmemory' }
}

function allowOnly(...ops: AgentmemoryOperation[]): (op: AgentmemoryOperation) => EnforceDecision {
  const set = new Set(ops)
  return (op) =>
    set.has(op)
      ? { allow: true }
      : { allow: false, reason: 'not-in-allowlist', dimension: 'agentmemory' }
}

describe('createAgentmemoryHandle', () => {
  it('short-circuits and emits permission.denied when policy denies', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const events = vi.fn()
    const handle = createAgentmemoryHandle({
      client,
      canUseAgentmemory: denyAll,
      events,
      runId: 'r',
      stepId: 's',
    })
    await handle.observe({ sessionId: 's', hookType: 'post_tool_use', data: {} })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'permission.denied',
        dimension: 'agentmemory',
        runId: 'r',
        stepId: 's',
      }),
    )
  })

  it('forwards observe/session/search/context when policy allows', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ hits: [] }),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const audit = vi.fn()
    const handle = createAgentmemoryHandle({
      client,
      canUseAgentmemory: allowAll,
      audit,
      defaultProject: '/proj',
    })
    await handle.startSession({ sessionId: 'sess' })
    await handle.observe({ sessionId: 'sess', hookType: 'post_tool_use', data: { x: 1 } })
    const search = await handle.smartSearch({ query: 'jwt', limit: 3 })
    await handle.endSession({ sessionId: 'sess' })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(audit).toHaveBeenCalledTimes(4)
    expect(search.hits).toEqual([])
  })

  it('swallows transport errors and emits agentmemory.error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('econnrefused')
    }) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const events = vi.fn()
    const handle = createAgentmemoryHandle({
      client,
      canUseAgentmemory: allowAll,
      events,
    })
    await expect(
      handle.observe({ sessionId: 's', hookType: 'post_tool_use', data: {} }),
    ).resolves.toBeUndefined()
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agentmemory.error', op: 'observe' }),
    )
  })

  it('returns empty result on denied smartSearch without throwing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const handle = createAgentmemoryHandle({ client, canUseAgentmemory: denyAll })
    const res = await handle.smartSearch({ query: 'q' })
    expect(res.hits).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards save/recall/sessions/graphQuery when allowed and audits each', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/remember')) return jsonResponse({ memory: { id: 'm1' } })
      if (url.includes('/memories'))
        return jsonResponse({ memories: [{ id: '1', title: 'A', content: 'a' }] })
      if (url.includes('/sessions')) return jsonResponse({ sessions: [{ id: 's1' }] })
      if (url.endsWith('/graph/query'))
        return jsonResponse({ nodes: [{ id: 'n', label: 'L' }], edges: [] })
      return jsonResponse({})
    }) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const audit = vi.fn()
    const handle = createAgentmemoryHandle({ client, canUseAgentmemory: allowAll, audit })

    expect(await handle.save({ title: 'T', content: 'C' })).toEqual({ id: 'm1' })
    expect((await handle.recall({})).hits).toHaveLength(1)
    expect((await handle.sessions({})).sessions).toEqual([{ id: 's1' }])
    const graph = await handle.graphQuery({ query: 'q' })
    expect(graph.nodes).toHaveLength(1)

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agentmemory.save', id: 'm1' }),
    )
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agentmemory.recall', hits: 1 }),
    )
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agentmemory.sessions', count: 1 }),
    )
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agentmemory.graph', nodes: 1 }),
    )
  })

  it('gates recall and sessions on the recall op; graph and save independently', async () => {
    const fetchMock = vi.fn(async (input: unknown) =>
      String(input).includes('/sessions')
        ? jsonResponse({ sessions: [{ id: 's1' }] })
        : jsonResponse({ hits: [] }),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const events = vi.fn()
    const handle = createAgentmemoryHandle({
      client,
      canUseAgentmemory: allowOnly('recall'),
      events,
    })

    // recall + sessions share the recall op → allowed
    expect((await handle.sessions({})).sessions).toEqual([{ id: 's1' }])
    expect((await handle.recall({})).hits).toEqual([])
    // save + graph not granted → short-circuit, empty results, no fetch
    expect(await handle.save({ title: 'T', content: 'C' })).toEqual({ id: '' })
    expect(await handle.graphQuery({ query: 'q' })).toEqual({ nodes: [], edges: [] })
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'permission.denied',
        detail: expect.stringContaining('save'),
      }),
    )
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'permission.denied',
        detail: expect.stringContaining('graph'),
      }),
    )
  })

  it('reports agentmemory.error with the op on a failed save', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('econnrefused')
    }) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const events = vi.fn()
    const handle = createAgentmemoryHandle({ client, canUseAgentmemory: allowAll, events })
    expect(await handle.save({ title: 'T', content: 'C' })).toEqual({ id: '' })
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agentmemory.error', op: 'save' }),
    )
  })

  it('falls back to defaultProject in the wire body when caller omits project', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: 'm1' }),
    ) as unknown as typeof globalThis.fetch
    const client = new AgentmemoryClient({ url: 'http://x', fetch: fetchMock })
    const handle = createAgentmemoryHandle({
      client,
      canUseAgentmemory: allowAll,
      defaultProject: '/proj',
    })
    await handle.save({ title: 'T', content: 'C' })
    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as RequestInit
    expect(JSON.parse(init.body as string)).toMatchObject({ project: '/proj' })
  })
})
