import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LLMTruncatedError } from '@skelm/core'
import { resolvePermissions } from '@skelm/core/permissions'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSkelmAgentBackend } from '../src/index.js'

// ---------------------------------------------------------------------------
// SSE chunk builders (OpenAI `stream: true` wire format)
// ---------------------------------------------------------------------------

function sseResponse(chunks: readonly unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function contentChunk(delta: string): unknown {
  return {
    id: 'chatcmpl-stream',
    object: 'chat.completion.chunk',
    model: 'mock-model',
    choices: [{ index: 0, delta: { content: delta } }],
  }
}

function reasoningChunk(delta: string): unknown {
  return { choices: [{ index: 0, delta: { reasoning_content: delta } }] }
}

function finishChunk(reason = 'stop'): unknown {
  return {
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

function toolCallChunk(
  index: number,
  part: { id?: string; name?: string; argumentsFragment?: string },
): unknown {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              ...(part.id !== undefined && { id: part.id, type: 'function' }),
              function: {
                ...(part.name !== undefined && { name: part.name }),
                ...(part.argumentsFragment !== undefined && { arguments: part.argumentsFragment }),
              },
            },
          ],
        },
      },
    ],
  }
}

function jsonCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function stubFetchQueue(responses: readonly (() => Response)[]): ReturnType<typeof vi.fn> {
  const queue = [...responses]
  const fetchSpy = vi.fn(async (): Promise<Response> => {
    const next = queue.shift()
    if (next === undefined) throw new Error('fetch stub exhausted')
    return next()
  })
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

function requestBody(fetchSpy: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  return JSON.parse((fetchSpy.mock.calls[call]?.[1] as { body: string }).body) as Record<
    string,
    unknown
  >
}

// ---------------------------------------------------------------------------
// Event-sink context
// ---------------------------------------------------------------------------

function makeEventCtx(extra: Record<string, unknown> = {}) {
  const events: Array<Record<string, unknown>> = []
  const ctx = {
    signal: new AbortController().signal,
    events: { publish: (ev: unknown) => events.push(ev as Record<string, unknown>) },
    runId: 'run-1',
    stepId: 'step-1',
    ...extra,
  }
  return { ctx, events }
}

function partialDeltas(events: ReadonlyArray<Record<string, unknown>>): string[] {
  return events.filter((e) => e.type === 'step.partial').map((e) => e.delta as string)
}

function makePolicy(overrides: Parameters<typeof resolvePermissions>[0] = {}) {
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
      ...overrides,
    },
    undefined,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Streaming agent loop
// ---------------------------------------------------------------------------

describe('SkelmAgentBackend — streaming', () => {
  it('emits step.partial per delta, in order, and the final text is the concatenation', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
    })
    const fetchSpy = stubFetchQueue([
      () =>
        sseResponse([
          contentChunk('Hel'),
          contentChunk('lo'),
          contentChunk(' world'),
          finishChunk(),
        ]),
    ])
    const { ctx, events } = makeEventCtx()

    const r = await backend.run?.({ prompt: 'greet' }, ctx)

    expect(r?.text).toBe('Hello world')
    expect(r?.stopReason).toBe('stop')
    expect(r?.usage?.inputTokens).toBe(10)
    expect(partialDeltas(events)).toEqual(['Hel', 'lo', ' world'])
    const partial = events.find((e) => e.type === 'step.partial')
    expect(partial).toMatchObject({ runId: 'run-1', stepId: 'step-1', kind: 'agent' })
    expect(requestBody(fetchSpy, 0).stream).toBe(true)
  })

  it('prefers ctx.onPartial when supplied (no direct step.partial publish)', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
    })
    stubFetchQueue([() => sseResponse([contentChunk('ab'), contentChunk('c'), finishChunk()])])
    const deltas: string[] = []
    const { ctx, events } = makeEventCtx({ onPartial: (d: string) => deltas.push(d) })

    const r = await backend.run?.({ prompt: 'greet' }, ctx)

    expect(r?.text).toBe('abc')
    expect(deltas).toEqual(['ab', 'c'])
    expect(partialDeltas(events)).toEqual([])
  })

  it('assembles streamed tool_calls deltas and executes the tool, then streams the final turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-agent-stream-'))
    await writeFile(join(dir, 'hello.txt'), 'tool says hi', 'utf8')
    try {
      const backend = createSkelmAgentBackend({
        baseUrl: 'http://example.invalid',
        model: 'mock-model',
      })
      const fetchSpy = stubFetchQueue([
        () =>
          sseResponse([
            toolCallChunk(0, { id: 'call_1', name: 'fs_read', argumentsFragment: '' }),
            toolCallChunk(0, { argumentsFragment: '{"path":"hel' }),
            toolCallChunk(0, { argumentsFragment: 'lo.txt"}' }),
            finishChunk('tool_calls'),
          ]),
        () => sseResponse([contentChunk('Done: '), contentChunk('tool says hi'), finishChunk()]),
      ])
      const { ctx, events } = makeEventCtx()

      const r = await backend.run?.({ prompt: 'read the file', cwd: dir }, ctx)

      expect(r?.text).toBe('Done: tool says hi')
      expect(partialDeltas(events)).toEqual(['Done: ', 'tool says hi'])
      // The second request must carry the executed tool result back.
      const second = requestBody(fetchSpy, 1) as { messages: Array<Record<string, unknown>> }
      const toolMsg = second.messages.find((m) => m.role === 'tool')
      expect(toolMsg?.content).toBe('tool says hi')
      expect(toolMsg?.tool_call_id).toBe('call_1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the non-streaming path bit-for-bit when no event sink is present', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
    })
    const fetchSpy = stubFetchQueue([() => jsonCompletion('plain answer')])

    const r = await backend.run?.({ prompt: 'greet' }, { signal: new AbortController().signal })

    expect(r?.text).toBe('plain answer')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(requestBody(fetchSpy, 0).stream).toBe(false)
  })

  it('handles an upstream that ignores stream:true and replies with plain JSON', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
    })
    const fetchSpy = stubFetchQueue([() => jsonCompletion('full text')])
    const { ctx, events } = makeEventCtx()

    const r = await backend.run?.({ prompt: 'greet' }, ctx)

    expect(r?.text).toBe('full text')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // The whole reply surfaces as a single delta so concatenation still holds.
    expect(partialDeltas(events)).toEqual(['full text'])
  })

  it('falls back to the non-streaming request when the upstream rejects stream:true', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
    })
    const fetchSpy = stubFetchQueue([
      () =>
        new Response(JSON.stringify({ error: { message: 'stream unsupported' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      () => jsonCompletion('fallback answer'),
    ])
    const { ctx, events } = makeEventCtx()

    const r = await backend.run?.({ prompt: 'greet' }, ctx)

    expect(r?.text).toBe('fallback answer')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(requestBody(fetchSpy, 0).stream).toBe(true)
    expect(requestBody(fetchSpy, 1).stream).toBe(false)
    expect(partialDeltas(events)).toEqual([])
  })

  it('preserves finish_reason length truncation handling on the streamed path', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
    })
    stubFetchQueue([
      () => sseResponse([reasoningChunk('thinking, endlessly'), finishChunk('length')]),
    ])
    const { ctx } = makeEventCtx()

    await expect(backend.run?.({ prompt: 'greet' }, ctx)).rejects.toThrow(LLMTruncatedError)
  })

  it('streaming does not bypass permission enforcement: denied tool emits permission.denied and is blocked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-agent-stream-deny-'))
    try {
      const backend = createSkelmAgentBackend({
        baseUrl: 'http://example.invalid',
        model: 'mock-model',
      })
      stubFetchQueue([
        () =>
          sseResponse([
            toolCallChunk(0, {
              id: 'call_1',
              name: 'fs_write',
              argumentsFragment: JSON.stringify({ path: join(dir, 'pwned.txt'), content: 'x' }),
            }),
            finishChunk('tool_calls'),
          ]),
        () => sseResponse([contentChunk('refused'), finishChunk()]),
      ])
      // Built-in tools deny via the explicit denylist (canUseBuiltinTool);
      // fsWrite stays granted to prove the denylist alone blocks the call.
      const { ctx, events } = makeEventCtx({
        permissions: makePolicy({ deniedTools: ['fs_write'], fsRead: [dir], fsWrite: [dir] }),
      })

      const r = await backend.run?.({ prompt: 'write the file', cwd: dir }, ctx)

      expect(r?.text).toBe('refused')
      const denied = events.find((e) => e.type === 'permission.denied')
      expect(denied).toMatchObject({ dimension: 'tool', runId: 'run-1', stepId: 'step-1' })
      expect(events.some((e) => e.type === 'tool.denied' && e.tool === 'fs_write')).toBe(true)
      await expect(stat(join(dir, 'pwned.txt'))).rejects.toThrow()
      // The model sees the denial as an error tool result, never the write.
      expect(await readFile(join(dir, 'pwned.txt'), 'utf8').catch(() => undefined)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
