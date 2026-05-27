import { join } from 'node:path'

import type { AgentmemoryHandle } from '@skelm/core'
import { resolvePermissions } from '@skelm/core/permissions'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSkelmAgentBackend } from '../src/index.js'

// Proof that @skelm/agent honors a supplied AgentmemoryHandle: it opens a
// session, captures the user prompt, prepends recall to the system prompt,
// observes each tool call, and closes the session in finally.

interface TurnStub {
  content?: string
  toolCalls?: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>
}

function buildChatResponse(turn: TurnStub): unknown {
  return {
    id: 'chatcmpl-stub',
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: turn.content ?? '',
          ...(turn.toolCalls && {
            tool_calls: turn.toolCalls.map((tc, i) => ({
              id: `call_${i}`,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          }),
        },
        finish_reason: turn.toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

function stubFetch(turns: readonly TurnStub[]): ReturnType<typeof vi.fn> {
  const queue = [...turns]
  const fetchSpy = vi.fn(async (): Promise<Response> => {
    const next = queue.shift() ?? turns[turns.length - 1] ?? { content: '' }
    return new Response(JSON.stringify(buildChatResponse(next)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

function makePolicy() {
  return resolvePermissions(
    {
      allowedTools: ['*'],
      allowedExecutables: [],
      allowedSkills: [],
      allowedMcpServers: [],
      allowedSecrets: [],
      fsRead: [process.cwd()],
      fsWrite: [process.cwd()],
      networkEgress: 'deny',
    },
    undefined,
  )
}

function fakeHandle(overrides: Partial<AgentmemoryHandle> = {}): AgentmemoryHandle {
  return {
    startSession: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    observe: vi.fn(async () => {}),
    smartSearch: vi.fn(async () => ({ hits: [] })),
    context: vi.fn(async () => ({ text: '' })),
    save: vi.fn(async () => ({ id: '' })),
    recall: vi.fn(async () => ({ hits: [] })),
    sessions: vi.fn(async () => ({ sessions: [] })),
    graphQuery: vi.fn(async () => ({ nodes: [], edges: [] })),
    ...overrides,
  }
}

const backend = createSkelmAgentBackend({ baseUrl: 'http://example.invalid', model: 'mock-model' })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('@skelm/agent — agentmemory wiring', () => {
  it('opens a session, captures the prompt, recalls, observes tool calls, and closes', async () => {
    const fetchSpy = stubFetch([
      {
        toolCalls: [{ name: 'fs_read', arguments: { path: join(process.cwd(), 'package.json') } }],
      },
      { content: 'DONE' },
    ])
    const agentmemory = fakeHandle({
      smartSearch: vi.fn(async () => ({ hits: [{ id: '1', title: 'JWT', content: 'use HS256' }] })),
    })

    const response = await backend.run?.(
      { prompt: 'How do we sign tokens?', maxTurns: 4 },
      { signal: new AbortController().signal, permissions: makePolicy(), agentmemory },
    )

    expect(response?.text).toBe('DONE')
    expect(agentmemory.startSession).toHaveBeenCalledOnce()
    expect(agentmemory.smartSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'How do we sign tokens?', limit: 5 }),
    )

    // The user prompt is captured, and the fs_read produces a post_tool_use observation.
    const observeCalls = (agentmemory.observe as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as { hookType: string; data: unknown },
    )
    expect(observeCalls.some((o) => o.hookType === 'user_prompt_submit')).toBe(true)
    expect(observeCalls.some((o) => o.hookType === 'post_tool_use')).toBe(true)
    // The final answer is recorded as task_completed (consistent with the
    // other backends), not just the prompt and tool calls.
    const completed = observeCalls.find((o) => o.hookType === 'task_completed')
    expect(completed).toBeDefined()
    expect((completed?.data as { result: string }).result).toContain('DONE')

    // Recall hit is prepended to the system message of the first model call.
    const firstBody = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body) as {
      messages: Array<{ role: string; content: string }>
    }
    const systemMsg = firstBody.messages.find((m) => m.role === 'system')
    expect(systemMsg?.content).toContain('<memory>')
    expect(systemMsg?.content).toContain('- JWT: use HS256')

    expect(agentmemory.endSession).toHaveBeenCalledWith({ sessionId: expect.any(String) })
  })

  it('closes the session in finally even when the run throws', async () => {
    // An empty choices array makes the loop throw BackendUpstreamError.
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'x', model: 'm', choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const agentmemory = fakeHandle()

    await expect(
      backend.run?.(
        { prompt: 'anything', maxTurns: 2 },
        { signal: new AbortController().signal, permissions: makePolicy(), agentmemory },
      ),
    ).rejects.toBeTruthy()

    expect(agentmemory.startSession).toHaveBeenCalledOnce()
    expect(agentmemory.endSession).toHaveBeenCalledOnce()
  })

  it('runs without a handle (integration disabled)', async () => {
    stubFetch([{ content: 'NO_MEMORY' }])
    const response = await backend.run?.(
      { prompt: 'hi', maxTurns: 2 },
      { signal: new AbortController().signal, permissions: makePolicy() },
    )
    expect(response?.text).toBe('NO_MEMORY')
  })
})
