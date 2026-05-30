import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelRegistry, createSkelmAgentBackend } from '../../src/index.js'

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'x',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('createSkelmAgentBackend — registry routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('routes inference() to the registry entry resolved from req.model', async () => {
    const registry = new ModelRegistry()
    registry.registerProvider('cloud', {
      baseUrl: 'https://cloud.example/v1',
      apiKey: 'cloud-key',
      models: [
        {
          id: 'big',
          api: 'openai-completions',
          input: ['text'],
          contextWindow: 32_000,
          maxTokens: 4096,
          cost: { input: 0, output: 0 },
          reasoning: false,
        },
      ],
    })
    registry.registerProvider('local', {
      baseUrl: 'http://local.example/v1',
      models: [
        {
          id: 'small',
          api: 'openai-completions',
          input: ['text'],
          contextWindow: 8_000,
          maxTokens: 1024,
          cost: { input: 0, output: 0 },
          reasoning: false,
        },
      ],
    })

    const fetchSpy = vi.fn(async () => chatResponse('hello'))
    vi.stubGlobal('fetch', fetchSpy)

    const backend = createSkelmAgentBackend({
      registry,
      defaultModel: { provider: 'local', id: 'small' },
    })

    const ctx = { permissions: undefined, signal: undefined } as never
    const res = await backend.inference(
      { messages: [{ role: 'user', content: 'hi' }], model: 'big' },
      ctx,
    )
    expect(res.text).toBe('hello')

    const callUrl = fetchSpy.mock.calls[0]?.[0] as string
    expect(callUrl).toBe('https://cloud.example/v1/chat/completions')
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cloud-key')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('big')
    expect(body.max_tokens).toBe(4096)
  })

  it('falls back to defaultModel when req.model is unset', async () => {
    const registry = new ModelRegistry()
    registry.registerProvider('local', {
      baseUrl: 'http://local.example/v1',
      models: [
        {
          id: 'small',
          api: 'openai-completions',
          input: ['text'],
          contextWindow: 8_000,
          maxTokens: 1024,
          cost: { input: 0, output: 0 },
          reasoning: false,
        },
      ],
    })

    const fetchSpy = vi.fn(async () => chatResponse('ok'))
    vi.stubGlobal('fetch', fetchSpy)

    const backend = createSkelmAgentBackend({
      registry,
      defaultModel: { provider: 'local', id: 'small' },
    })

    await backend.inference({ messages: [{ role: 'user', content: 'hi' }] }, {
      permissions: undefined,
      signal: undefined,
    } as never)

    const callUrl = fetchSpy.mock.calls[0]?.[0] as string
    expect(callUrl).toBe('http://local.example/v1/chat/completions')
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body.model).toBe('small')
    expect(body.max_tokens).toBe(1024)
  })

  it('throws when req.model is unknown and no defaultModel is configured', async () => {
    const registry = new ModelRegistry()
    registry.registerProvider('p', {
      baseUrl: 'http://x',
      models: [
        {
          id: 'a',
          api: 'openai-completions',
          input: ['text'],
          contextWindow: 4_000,
          maxTokens: 512,
          cost: { input: 0, output: 0 },
          reasoning: false,
        },
      ],
    })
    const backend = createSkelmAgentBackend({ registry } as never)
    await expect(
      backend.inference({ messages: [{ role: 'user', content: 'hi' }], model: 'b' }, {
        permissions: undefined,
        signal: undefined,
      } as never),
    ).rejects.toThrow(/not found in registry/)
  })

  it('throws when registry is set but defaultModel is missing on a no-model request', async () => {
    const registry = new ModelRegistry()
    registry.registerProvider('p', {
      baseUrl: 'http://x',
      models: [
        {
          id: 'a',
          api: 'openai-completions',
          input: ['text'],
          contextWindow: 4_000,
          maxTokens: 512,
          cost: { input: 0, output: 0 },
          reasoning: false,
        },
      ],
    })
    const backend = createSkelmAgentBackend({ registry } as never)
    await expect(
      backend.inference({ messages: [{ role: 'user', content: 'hi' }] }, {
        permissions: undefined,
        signal: undefined,
      } as never),
    ).rejects.toThrow(/defaultModel/)
  })

  it('throws when neither baseUrl nor registry is provided', async () => {
    const backend = createSkelmAgentBackend({} as never)
    await expect(
      backend.inference({ messages: [{ role: 'user', content: 'hi' }] }, {
        permissions: undefined,
        signal: undefined,
      } as never),
    ).rejects.toThrow(/baseUrl.*registry/)
  })

  it('single-endpoint mode still works without a registry (back-compat)', async () => {
    const fetchSpy = vi.fn(async () => chatResponse('legacy ok'))
    vi.stubGlobal('fetch', fetchSpy)

    const backend = createSkelmAgentBackend({
      baseUrl: 'http://legacy.example/v1',
      apiKey: 'legacy-key',
      model: 'legacy-model',
    })

    await backend.inference({ messages: [{ role: 'user', content: 'hi' }] }, {
      permissions: undefined,
      signal: undefined,
    } as never)

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://legacy.example/v1/chat/completions')
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body.model).toBe('legacy-model')
  })

  it('per-call req.maxTokens overrides the registry entry maxTokens', async () => {
    const registry = new ModelRegistry()
    registry.registerProvider('p', {
      baseUrl: 'http://x',
      models: [
        {
          id: 'a',
          api: 'openai-completions',
          input: ['text'],
          contextWindow: 32_000,
          maxTokens: 4096,
          cost: { input: 0, output: 0 },
          reasoning: false,
        },
      ],
    })
    const fetchSpy = vi.fn(async () => chatResponse('ok'))
    vi.stubGlobal('fetch', fetchSpy)

    const backend = createSkelmAgentBackend({
      registry,
      defaultModel: { provider: 'p', id: 'a' },
    })
    await backend.inference({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 }, {
      permissions: undefined,
      signal: undefined,
    } as never)

    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(64)
  })
})
