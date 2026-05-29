import type { DelegateResult } from '@skelm/core'
import { resolvePermissions } from '@skelm/core/permissions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSkelmAgentBackend } from '../src/index.js'

// Exercises the `delegate` built-in tool through the real native agent loop.
// Only the LLM HTTP transport is mocked — the TrustEnforcer, the tool handler,
// and the canDelegate gate are real. The `delegate` runtime callback is stubbed
// to stand in for runDelegation (which is covered in @skelm/core tests).

function chatResponse(turn: {
  content?: string
  toolCalls?: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>
}): unknown {
  return {
    id: 'c1',
    object: 'chat.completion',
    model: 'm',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: turn.content ?? '',
          ...(turn.toolCalls && {
            tool_calls: turn.toolCalls.map((tc, i) => ({
              id: `tool_${i}`,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          }),
        },
        finish_reason: turn.toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function stubFetch(
  turns: ReadonlyArray<Parameters<typeof chatResponse>[0]>,
): ReturnType<typeof vi.fn> {
  const queue = [...turns]
  const spy = vi.fn(async () => {
    const next = queue.shift() ?? turns[turns.length - 1]
    return new Response(JSON.stringify(chatResponse(next ?? { content: '' })), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

function lastToolMessage(
  fetchSpy: ReturnType<typeof vi.fn>,
  callIndex: number,
): string | undefined {
  const body = JSON.parse((fetchSpy.mock.calls[callIndex]?.[1] as { body: string }).body) as {
    messages: Array<{ role: string; content: string }>
  }
  return body.messages.filter((m) => m.role === 'tool').at(-1)?.content
}

const backend = createSkelmAgentBackend({ baseUrl: 'http://example.invalid', model: 'mock-model' })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('delegate tool — native agent loop', () => {
  it('delegates to an allowlisted target and returns the structured envelope to the model', async () => {
    const fetchSpy = stubFetch([
      {
        toolCalls: [
          { name: 'delegate', arguments: { agentId: 'research.agent', input: { q: 'x' } } },
        ],
      },
      { content: 'done' },
    ])
    const delegate = vi.fn(
      async (): Promise<DelegateResult> => ({
        status: 'completed',
        runId: 'child-1',
        output: { answer: 42 },
      }),
    )

    const response = await backend.run?.(
      { prompt: 'route it', maxTurns: 3 },
      {
        signal: new AbortController().signal,
        permissions: resolvePermissions(undefined, { delegation: ['research.agent'] }),
        delegate,
      },
    )

    expect(response?.text).toBe('done')
    expect(delegate).toHaveBeenCalledWith('research.agent', { q: 'x' })
    const toolMsg = lastToolMessage(fetchSpy, 1)
    expect(toolMsg).toContain('"status": "completed"')
    expect(toolMsg).toContain('"answer": 42')
  })

  it('denies a target not on the delegation allowlist and emits permission.denied', async () => {
    stubFetch([
      { toolCalls: [{ name: 'delegate', arguments: { agentId: 'evil.agent' } }] },
      { content: 'blocked' },
    ])
    const delegate = vi.fn(
      async (): Promise<DelegateResult> => ({ status: 'completed', runId: 'x' }),
    )
    const events: Array<{ type?: string; dimension?: string }> = []

    const response = await backend.run?.(
      { prompt: 'route it', maxTurns: 3 },
      {
        signal: new AbortController().signal,
        permissions: resolvePermissions(undefined, { delegation: ['research.agent'] }),
        delegate,
        events: { publish: (ev) => events.push(ev as { type?: string }) },
        runId: 'parent-run',
        stepId: 'router',
      },
    )

    expect(response?.text).toBe('blocked')
    expect(delegate).not.toHaveBeenCalled()
    const denied = events.find((e) => e.type === 'permission.denied')
    expect(denied?.dimension).toBe('delegation')
  })

  it('reports a clear error when delegation is not wired for the run', async () => {
    const fetchSpy = stubFetch([
      { toolCalls: [{ name: 'delegate', arguments: { agentId: 'research.agent' } }] },
      { content: 'no-deleg' },
    ])

    const response = await backend.run?.(
      { prompt: 'route it', maxTurns: 3 },
      {
        signal: new AbortController().signal,
        permissions: resolvePermissions(undefined, { delegation: ['research.agent'] }),
        // no delegate callback wired
      },
    )

    expect(response?.text).toBe('no-deleg')
    expect(lastToolMessage(fetchSpy, 1)).toContain('Delegation is unavailable')
  })

  it('surfaces a failed child run as a structured envelope (not a tool error)', async () => {
    const fetchSpy = stubFetch([
      { toolCalls: [{ name: 'delegate', arguments: { agentId: 'research.agent' } }] },
      { content: 'handled' },
    ])
    const delegate = vi.fn(
      async (): Promise<DelegateResult> => ({
        status: 'failed',
        runId: 'child-2',
        error: 'specialist exploded',
      }),
    )

    const response = await backend.run?.(
      { prompt: 'route it', maxTurns: 3 },
      {
        signal: new AbortController().signal,
        permissions: resolvePermissions(undefined, { delegation: ['research.agent'] }),
        delegate,
      },
    )

    expect(response?.text).toBe('handled')
    const toolMsg = lastToolMessage(fetchSpy, 1)
    expect(toolMsg).toContain('"status": "failed"')
    expect(toolMsg).toContain('specialist exploded')
  })
})
