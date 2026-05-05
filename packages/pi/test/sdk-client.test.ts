/**
 * Tests for PiSdkClient — covers the parts the backend tests can't reach
 * because they mock PiSdkClient itself: the systemPromptOverride function,
 * SDK option forwarding, and assistant-message extraction from agent_end.
 */

import { describe, expect, it, vi } from 'vitest'

// Capture what we pass to the SDK so we can assert on it
let lastServicesOptions: unknown
let lastFromServicesOptions: unknown

const mockSession = {
  subscribe: vi.fn(),
  prompt: vi.fn().mockResolvedValue(undefined),
  abort: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn(),
}

vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSessionServices: vi.fn(async (opts: unknown) => {
    lastServicesOptions = opts
    return { cwd: '/x', agentDir: '/y', diagnostics: [] }
  }),
  createAgentSessionFromServices: vi.fn(async (opts: unknown) => {
    lastFromServicesOptions = opts
    return { session: mockSession, extensionsResult: {} }
  }),
  SessionManager: { inMemory: () => ({ kind: 'inMemory' }) },
}))

import { PiSdkClient } from '../src/sdk-client.js'

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

  it('returns empty text when there is no assistant message', async () => {
    mockSession.subscribe.mockImplementation((listener: (e: unknown) => void) => {
      queueMicrotask(() => listener({ type: 'agent_end', messages: [] }))
      return () => {}
    })

    const result = await new PiSdkClient().prompt('go')
    expect(result.text).toBe('')
    expect(result.stopReason).toBe('stop')
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
