import { afterEach, describe, expect, it, vi } from 'vitest'

import { InMemorySessionStore, createSkelmAgentBackend } from '../src/index.js'

// Milestone A: when a `sessionStore` is configured, an agent() run that supplies
// a `sessionId` resumes the prior conversation (the saved user/assistant/tool
// turns are seeded ahead of the new prompt) and the updated history is saved
// back on completion. A fresh system prompt is rebuilt every run, so the
// persisted system turn is never replayed.

interface TurnStub {
  content?: string
}

function buildChatResponse(turn: TurnStub): unknown {
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: turn.content ?? '' },
        finish_reason: 'stop',
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

const ctx = () => ({ signal: new AbortController().signal })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SkelmAgentBackend — session lifecycle (Milestone A)', () => {
  it('advertises sessionLifecycle only when a sessionStore is configured', () => {
    const stateless = createSkelmAgentBackend({ baseUrl: 'http://example.invalid' })
    expect(stateless.capabilities.sessionLifecycle).toBe(false)

    const stateful = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      sessionStore: new InMemorySessionStore(),
    })
    expect(stateful.capabilities.sessionLifecycle).toBe(true)
  })

  it('resumes the prior conversation across run() calls with the same sessionId', async () => {
    const store = new InMemorySessionStore()
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      sessionStore: store,
    })
    const fetchSpy = stubFetch([{ content: 'first answer' }, { content: 'second answer' }])

    const r1 = await backend.run?.({ prompt: 'hello', sessionId: 's1' }, ctx())
    expect(r1?.text).toBe('first answer')

    const r2 = await backend.run?.({ prompt: 'and again', sessionId: 's1' }, ctx())
    expect(r2?.text).toBe('second answer')

    // The SECOND request must carry the prior turn ahead of the new prompt:
    // [system, user:hello, assistant:first answer, user:and again].
    const body = JSON.parse((fetchSpy.mock.calls[1]?.[1] as { body: string }).body) as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(body.messages[1]?.content).toBe('hello')
    expect(body.messages[2]?.content).toBe('first answer')
    expect(body.messages[3]?.content).toBe('and again')

    // The full updated history (system dropped) is persisted under the sessionId.
    const saved = await store.load('s1')
    expect(saved?.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:hello',
      'assistant:first answer',
      'user:and again',
      'assistant:second answer',
    ])
  })

  it('does not persist when no sessionId is supplied', async () => {
    const store = new InMemorySessionStore()
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      sessionStore: store,
    })
    stubFetch([{ content: 'ok' }])

    await backend.run?.({ prompt: 'no session here' }, ctx())
    expect(await store.list()).toEqual([])
  })

  it('runs normally with a sessionId when no store is configured (no persistence)', async () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
    })
    stubFetch([{ content: 'fine' }])

    const r = await backend.run?.({ prompt: 'hi', sessionId: 'sX' }, ctx())
    expect(r?.text).toBe('fine')
    expect(backend.capabilities.sessionLifecycle).toBe(false)
  })

  it('falls back to stateless and warns when sessionStore.load() throws', async () => {
    const store = new InMemorySessionStore()
    vi.spyOn(store, 'load').mockRejectedValue(new Error('store unavailable'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      sessionStore: store,
    })
    stubFetch([{ content: 'answer despite load failure' }])

    const r = await backend.run?.({ prompt: 'hello', sessionId: 'sErr' }, ctx())
    expect(r?.text).toBe('answer despite load failure')
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('session load failed'),
      expect.any(Error),
    )
  })

  it('still returns the LLM response and warns when sessionStore.save() throws', async () => {
    const store = new InMemorySessionStore()
    vi.spyOn(store, 'save').mockRejectedValue(new Error('disk full'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      sessionStore: store,
    })
    stubFetch([{ content: 'answer despite save failure' }])

    const r = await backend.run?.({ prompt: 'hello', sessionId: 'sSave' }, ctx())
    expect(r?.text).toBe('answer despite save failure')
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('session save failed'),
      expect.any(Error),
    )
  })
})
