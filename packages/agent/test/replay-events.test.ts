import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolvePermissions } from '@skelm/core/permissions'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSkelmAgentBackend } from '../src/index.js'

// Replay contract: native built-in tool execution must surface tool.call /
// tool.result on the run bus with the same shape McpHost emits for MCP tools,
// so a dashboard can reconstruct the run from events alone.

interface ToolCallStub {
  id?: string
  name: string
  arguments: Record<string, unknown>
}

interface TurnStub {
  content?: string
  toolCalls?: readonly ToolCallStub[]
}

function buildChatResponse(turn: TurnStub): unknown {
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: turn.content ?? '',
          ...(turn.toolCalls && {
            tool_calls: turn.toolCalls.map((tc, i) => ({
              id: tc.id ?? `call_${i}`,
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
    const next = queue.shift() ?? turns[turns.length - 1] ?? {}
    return new Response(JSON.stringify(buildChatResponse(next)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

function makeEventCtx(extra: Record<string, unknown> = {}) {
  const events: Array<Record<string, unknown>> = []
  const ctx = {
    signal: new AbortController().signal,
    events: { publish: (ev: unknown) => events.push(ev as Record<string, unknown>) },
    runId: 'run-replay',
    stepId: 'step-replay',
    ...extra,
  }
  return { ctx, events }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SkelmAgentBackend — replay-grade tool events', () => {
  it('emits tool.call and tool.result for native built-in tool execution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-agent-replay-'))
    await writeFile(join(dir, 'data.txt'), 'replayable', 'utf8')
    try {
      const backend = createSkelmAgentBackend({
        baseUrl: 'http://example.invalid',
        model: 'mock-model',
      })
      stubFetch([
        { toolCalls: [{ id: 'call_9', name: 'fs_read', arguments: { path: 'data.txt' } }] },
        { content: 'done' },
      ])
      const { ctx, events } = makeEventCtx()

      const r = await backend.run?.({ prompt: 'read it', cwd: dir }, ctx)

      expect(r?.text).toBe('done')
      const call = events.find((e) => e.type === 'tool.call')
      expect(call).toMatchObject({
        runId: 'run-replay',
        stepId: 'step-replay',
        tool: 'fs_read',
        arguments: { path: 'data.txt' },
      })
      const result = events.find((e) => e.type === 'tool.result')
      expect(result).toMatchObject({
        runId: 'run-replay',
        stepId: 'step-replay',
        tool: 'fs_read',
        result: { content: 'replayable' },
      })
      expect(typeof result?.durationMs).toBe('number')
      // call precedes result in publication order.
      expect(events.indexOf(call as Record<string, unknown>)).toBeLessThan(
        events.indexOf(result as Record<string, unknown>),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('flags failed tool executions with isError on tool.result', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
    })
    stubFetch([
      { toolCalls: [{ name: 'fs_read', arguments: { path: 'no-such-file.txt' } }] },
      { content: 'gave up' },
    ])
    const { ctx, events } = makeEventCtx()

    const r = await backend.run?.({ prompt: 'read it' }, ctx)

    expect(r?.text).toBe('gave up')
    const result = events.find((e) => e.type === 'tool.result')
    expect(result).toMatchObject({ tool: 'fs_read', result: { isError: true } })
  })

  it('a denied built-in emits tool.denied + permission.denied and NO tool.call/tool.result', async () => {
    const policy = resolvePermissions(
      {
        allowedTools: ['*'],
        deniedTools: ['fs_read'],
        allowedExecutables: [],
        allowedSkills: [],
        allowedMcpServers: [],
        allowedSecrets: [],
        fsRead: [process.cwd()],
        fsWrite: [],
        networkEgress: 'deny',
      },
      undefined,
    )
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
    })
    stubFetch([
      { toolCalls: [{ name: 'fs_read', arguments: { path: 'package.json' } }] },
      { content: 'refused' },
    ])
    const { ctx, events } = makeEventCtx({ permissions: policy })

    const r = await backend.run?.({ prompt: 'read it' }, ctx)

    expect(r?.text).toBe('refused')
    expect(events.some((e) => e.type === 'tool.denied' && e.tool === 'fs_read')).toBe(true)
    expect(events.some((e) => e.type === 'permission.denied')).toBe(true)
    expect(events.some((e) => e.type === 'tool.call')).toBe(false)
    expect(events.some((e) => e.type === 'tool.result')).toBe(false)
  })

  it('invokes onPromptAssembled with the assembled system prompt and tool list', async () => {
    const seen: Array<{ systemPrompt: string; tools: readonly string[] }> = []
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      onPromptAssembled: (info) => seen.push(info),
    })
    stubFetch([{ content: 'hi' }])

    const r = await backend.run?.({ prompt: 'greet' }, { signal: new AbortController().signal })

    expect(r?.text).toBe('hi')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.tools).toContain('fs_read')
    expect(seen[0]?.tools).toContain('exec')
    expect(seen[0]?.systemPrompt.length).toBeGreaterThan(0)
  })
})
