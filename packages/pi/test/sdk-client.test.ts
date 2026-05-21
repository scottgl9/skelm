/**
 * Tests for PiSdkClient — covers the parts the backend tests can't reach
 * because they mock PiSdkClient itself: the systemPromptOverride function,
 * SDK option forwarding, and assistant-message extraction from agent_end.
 */

import { describe, expect, it, vi } from 'vitest'

// Capture what we pass to the SDK so we can assert on it
let lastServicesOptions: unknown
let lastFromServicesOptions: unknown
let lastRegisteredProvider: { name: string; config: unknown } | undefined

const mockSession = {
  subscribe: vi.fn(),
  prompt: vi.fn().mockResolvedValue(undefined),
  abort: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn(),
}

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSessionServices: vi.fn(async (opts: unknown) => {
    lastServicesOptions = opts
    return {
      cwd: '/x',
      agentDir: '/y',
      diagnostics: [],
      modelRegistry: {
        registerProvider: (name: string, config: unknown) => {
          lastRegisteredProvider = { name, config }
        },
        find: (provider: string, model: string) => ({ provider, id: model, name: model }),
      },
    }
  }),
  createAgentSessionFromServices: vi.fn(async (opts: unknown) => {
    lastFromServicesOptions = opts
    return { session: mockSession, extensionsResult: {} }
  }),
  SessionManager: { inMemory: () => ({ kind: 'inMemory' }) },
}))

import { PiSdkClient, PiSdkUpstreamError } from '../src/sdk-client.js'

function emitAgentEnd(text: string, stopReason = 'stop' as const) {
  // Wire subscribe → fire agent_end on next tick after prompt() resolves
  mockSession.subscribe.mockImplementation((listener: (e: unknown) => void) => {
    queueMicrotask(() =>
      listener({
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text }],
            stopReason,
            usage: { input: 11, output: 22 },
          },
        ],
      }),
    )
    return () => {}
  })
}

describe('PiSdkClient — SDK forwarding', () => {
  it('forwards cwd, defaulting to process.cwd() when omitted', async () => {
    emitAgentEnd('hi')
    await new PiSdkClient().prompt('go')
    expect((lastServicesOptions as { cwd: string }).cwd).toBe(process.cwd())
  })

  it('forwards explicit cwd', async () => {
    emitAgentEnd('hi')
    await new PiSdkClient({ cwd: '/custom' }).prompt('go')
    expect((lastServicesOptions as { cwd: string }).cwd).toBe('/custom')
  })

  it('defaults noExtensions and noSkills to true; noContextFiles unset', async () => {
    emitAgentEnd('hi')
    await new PiSdkClient().prompt('go')
    const opts = (lastServicesOptions as { resourceLoaderOptions: Record<string, unknown> })
      .resourceLoaderOptions
    expect(opts.noExtensions).toBe(true)
    expect(opts.noSkills).toBe(true)
    expect(opts.noContextFiles).toBeUndefined()
  })

  it('forwards explicit overrides for sandbox flags', async () => {
    emitAgentEnd('hi')
    await new PiSdkClient({ noExtensions: false, noSkills: false, noContextFiles: true }).prompt(
      'go',
    )
    const opts = (lastServicesOptions as { resourceLoaderOptions: Record<string, unknown> })
      .resourceLoaderOptions
    expect(opts.noExtensions).toBe(false)
    expect(opts.noSkills).toBe(false)
    expect(opts.noContextFiles).toBe(true)
  })

  it('forwards tools and noTools to createAgentSessionFromServices', async () => {
    emitAgentEnd('hi')
    await new PiSdkClient({ tools: ['bash', 'read'], noTools: 'all' }).prompt('go')
    const opts = lastFromServicesOptions as { tools?: string[]; noTools?: string }
    expect(opts.tools).toEqual(['bash', 'read'])
    expect(opts.noTools).toBe('all')
  })

  it('registers providerOverride on the ModelRegistry before session creation (F119)', async () => {
    lastRegisteredProvider = undefined
    emitAgentEnd('hi')
    await new PiSdkClient({
      providerOverride: {
        provider: 'openai',
        model: 'qwen36',
        baseUrl: 'http://localhost:8000/v1',
        apiKey: 'unused',
      },
    }).prompt('go')
    expect(lastRegisteredProvider?.name).toBe('openai')
    const cfg = lastRegisteredProvider?.config as {
      baseUrl?: string
      apiKey?: string
      models?: Array<{ id: string; api: string }>
    }
    expect(cfg.baseUrl).toBe('http://localhost:8000/v1')
    expect(cfg.apiKey).toBe('unused')
    expect(cfg.models?.[0]?.id).toBe('qwen36')
    expect(cfg.models?.[0]?.api).toBe('openai-completions')
    // model resolved via modelRegistry.find() is passed to the session factory
    const opts = lastFromServicesOptions as { model?: { id: string } }
    expect(opts.model?.id).toBe('qwen36')
  })

  it('skips override entirely when no provider/model/env hint is set', async () => {
    lastRegisteredProvider = undefined
    emitAgentEnd('hi')
    await new PiSdkClient({}).prompt('go')
    expect(lastRegisteredProvider).toBeUndefined()
    const opts = lastFromServicesOptions as { model?: unknown }
    expect(opts.model).toBeUndefined()
  })
})

describe('PiSdkClient — systemPromptOverride function', () => {
  function getOverride(): ((base: string | undefined) => string | undefined) | undefined {
    const opts = lastServicesOptions as {
      resourceLoaderOptions: {
        systemPromptOverride?: (b: string | undefined) => string | undefined
      }
    }
    return opts.resourceLoaderOptions.systemPromptOverride
  }

  it('does not install an override when system is omitted', async () => {
    emitAgentEnd('hi')
    await new PiSdkClient().prompt('go')
    expect(getOverride()).toBeUndefined()
  })

  it('appends system to base when replaceSystemPrompt is false', async () => {
    emitAgentEnd('hi')
    await new PiSdkClient({ system: 'Be concise.' }).prompt('go')
    const override = getOverride()
    expect(override?.('You are pi.')).toBe('You are pi.\n\nBe concise.')
  })

  it('returns just system when base is undefined and replaceSystemPrompt is false', async () => {
    emitAgentEnd('hi')
    await new PiSdkClient({ system: 'Only this.' }).prompt('go')
    expect(getOverride()?.(undefined)).toBe('Only this.')
  })

  it('replaces base when replaceSystemPrompt is true', async () => {
    emitAgentEnd('hi')
    await new PiSdkClient({ system: 'Replacement.', replaceSystemPrompt: true }).prompt('go')
    expect(getOverride()?.('You are pi.')).toBe('Replacement.')
  })

  it('replaceSystemPrompt:true returns the replacement even when base is undefined', async () => {
    emitAgentEnd('hi')
    await new PiSdkClient({ system: 'Replacement.', replaceSystemPrompt: true }).prompt('go')
    expect(getOverride()?.(undefined)).toBe('Replacement.')
  })

  // Issue #193 — when image content is threaded but no user system override
  // is set, append a vision-enable hint so pi's coding-agent prompt doesn't
  // bias the model into refusing to look at the image.
  const IMG = [{ mimeType: 'image/png', data: 'ZmFrZQ==' }]

  it('appends a vision hint to pi base prompt when images are present and no user system is set (#193)', async () => {
    emitAgentEnd('ok')
    await new PiSdkClient().prompt('describe it', undefined, undefined, undefined, IMG)
    const override = getOverride()
    expect(override).toBeDefined()
    const out = override?.('You are an expert coding assistant.') ?? ''
    expect(out).toContain('You are an expert coding assistant.')
    expect(out).toMatch(/vision capability/i)
  })

  it('returns only the vision hint when images present but base is undefined and no user system', async () => {
    emitAgentEnd('ok')
    await new PiSdkClient().prompt('describe it', undefined, undefined, undefined, IMG)
    const out = getOverride()?.(undefined) ?? ''
    expect(out).toMatch(/vision capability/i)
    expect(out).not.toMatch(/^You are/)
  })

  it('composes base + user system + vision hint in order (images, replace:false)', async () => {
    emitAgentEnd('ok')
    await new PiSdkClient({ system: 'Be terse.' }).prompt(
      'describe it',
      undefined,
      undefined,
      undefined,
      IMG,
    )
    const out = getOverride()?.('You are pi.') ?? ''
    expect(out).toBe(
      'You are pi.\n\nBe terse.\n\nThe user has attached one or more images to their message. You have vision capability — look at the image(s) and address what you see when answering.',
    )
  })

  it('does not double-inject vision hint when caller fully replaces the system prompt', async () => {
    emitAgentEnd('ok')
    await new PiSdkClient({
      system: 'You are an image describer.',
      replaceSystemPrompt: true,
    }).prompt('describe it', undefined, undefined, undefined, IMG)
    const out = getOverride()?.('You are pi.') ?? ''
    expect(out).toBe('You are an image describer.')
    expect(out).not.toMatch(/vision capability/i)
  })

  it('does NOT install an override when there are no images and no user system', async () => {
    emitAgentEnd('ok')
    await new PiSdkClient().prompt('describe it')
    expect(getOverride()).toBeUndefined()
  })
})

describe('PiSdkClient — assistant message extraction', () => {
  it('extracts text content and usage from the last assistant message', async () => {
    emitAgentEnd('the agent answer')
    const result = await new PiSdkClient().prompt('go')
    expect(result.text).toBe('the agent answer')
    expect(result.stopReason).toBe('stop')
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 })
  })

  it('concatenates multiple text blocks in order', async () => {
    mockSession.subscribe.mockImplementation((listener: (e: unknown) => void) => {
      queueMicrotask(() =>
        listener({
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'part one. ' },
                { type: 'tool_use', name: 'bash' },
                { type: 'text', text: 'part two.' },
              ],
              stopReason: 'stop',
              usage: { input: 1, output: 2 },
            },
          ],
        }),
      )
      return () => {}
    })

    const result = await new PiSdkClient().prompt('go')
    expect(result.text).toBe('part one. part two.')
  })

  it('rejects when there is no assistant message (was: silently returned empty text)', async () => {
    // Pre-fix this resolved with `{ text: '', stopReason: 'stop' }`, which the
    // runner recorded as a completed step. After F007 we promote this to a
    // real error so callers can't mistake it for success.
    mockSession.subscribe.mockImplementation((listener: (e: unknown) => void) => {
      queueMicrotask(() => listener({ type: 'agent_end', messages: [] }))
      return () => {}
    })

    await expect(new PiSdkClient().prompt('go')).rejects.toThrow(
      /pi agent terminated without producing an assistant message/,
    )
  })

  it('finds the LAST assistant message when multiple exist', async () => {
    mockSession.subscribe.mockImplementation((listener: (e: unknown) => void) => {
      queueMicrotask(() =>
        listener({
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'first' }],
              stopReason: 'stop',
              usage: { input: 1, output: 1 },
            },
            { role: 'user', content: 'follow up' },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'final answer' }],
              stopReason: 'stop',
              usage: { input: 5, output: 5 },
            },
          ],
        }),
      )
      return () => {}
    })

    const result = await new PiSdkClient().prompt('go')
    expect(result.text).toBe('final answer')
    expect(result.usage?.inputTokens).toBe(5)
  })

  it('disposes the session after a successful run', async () => {
    emitAgentEnd('hi')
    mockSession.dispose.mockClear()
    await new PiSdkClient().prompt('go')
    expect(mockSession.dispose).toHaveBeenCalledTimes(1)
  })

  it('rejects with abort error when signal is pre-aborted', async () => {
    emitAgentEnd('hi')
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(new PiSdkClient().prompt('go', ctrl.signal)).rejects.toThrow(/aborted/)
  })

  it('disposes the session on rejection', async () => {
    mockSession.dispose.mockClear()
    mockSession.subscribe.mockImplementation(() => () => {})
    mockSession.prompt.mockRejectedValueOnce(new Error('boom'))

    await expect(new PiSdkClient().prompt('go')).rejects.toThrow('boom')
    expect(mockSession.dispose).toHaveBeenCalled()
  })
})

describe('PiSdkClient — upstream error surface (F007)', () => {
  it("rejects with PiSdkUpstreamError when assistantMsg.stopReason is 'error'", async () => {
    mockSession.subscribe.mockImplementation((listener: (e: unknown) => void) => {
      queueMicrotask(() =>
        listener({
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              content: [],
              api: 'openai-responses',
              provider: 'openai',
              model: 'gpt-5.4',
              usage: { input: 0, output: 0 },
              stopReason: 'error',
              errorMessage: '401 Incorrect API key provided: unused.',
            },
          ],
        }),
      )
      return () => {}
    })

    let caught: unknown
    try {
      await new PiSdkClient().prompt('go')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PiSdkUpstreamError)
    const err = caught as PiSdkUpstreamError
    expect(err.stopReason).toBe('error')
    expect(err.upstreamErrorMessage).toBe('401 Incorrect API key provided: unused.')
    // Diagnostic should include provider/model + the upstream errorMessage.
    expect(err.message).toContain('pi inference failed')
    expect(err.message).toContain('provider=openai')
    expect(err.message).toContain('model=gpt-5.4')
    expect(err.message).toContain('401 Incorrect API key provided')
  })

  it("rejects with PiSdkUpstreamError when assistantMsg.stopReason is 'aborted'", async () => {
    mockSession.subscribe.mockImplementation((listener: (e: unknown) => void) => {
      queueMicrotask(() =>
        listener({
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              content: [],
              api: 'openai-responses',
              provider: 'openai',
              model: 'gpt-5.4',
              usage: { input: 0, output: 0 },
              stopReason: 'aborted',
              errorMessage: 'upstream cancelled the stream',
            },
          ],
        }),
      )
      return () => {}
    })

    await expect(new PiSdkClient().prompt('go')).rejects.toThrow(/pi inference aborted/)
  })

  it('rejects with a generic message when stopReason=error has no errorMessage', async () => {
    mockSession.subscribe.mockImplementation((listener: (e: unknown) => void) => {
      queueMicrotask(() =>
        listener({
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              content: [],
              api: 'openai-responses',
              provider: 'openai',
              model: 'gpt-5.4',
              usage: { input: 0, output: 0 },
              stopReason: 'error',
              // no errorMessage
            },
          ],
        }),
      )
      return () => {}
    })

    let caught: unknown
    try {
      await new PiSdkClient().prompt('go')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PiSdkUpstreamError)
    expect((caught as PiSdkUpstreamError).upstreamErrorMessage).toBeUndefined()
    expect((caught as Error).message).toMatch(/pi inference failed/)
  })

  it("does NOT reject for stopReason: 'stop' (success path remains intact)", async () => {
    mockSession.subscribe.mockImplementation((listener: (e: unknown) => void) => {
      queueMicrotask(() =>
        listener({
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'hi' }],
              api: 'x',
              provider: 'y',
              model: 'z',
              usage: { input: 5, output: 3 },
              stopReason: 'stop',
            },
          ],
        }),
      )
      return () => {}
    })
    const result = await new PiSdkClient().prompt('go')
    expect(result.text).toBe('hi')
    expect(result.stopReason).toBe('stop')
  })
})
