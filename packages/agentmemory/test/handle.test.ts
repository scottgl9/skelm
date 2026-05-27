import type { EnforceDecision } from '@skelm/core'
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
    const fetchMock = vi.fn(async () => jsonResponse({ hits: [] })) as unknown as typeof globalThis.fetch
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
})
