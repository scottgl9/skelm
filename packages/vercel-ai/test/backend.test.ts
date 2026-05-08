import type { BackendContext } from '@skelm/core'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createVercelAiBackend } from '../src/index.js'

function makeCtx(overrides: Partial<BackendContext> = {}): BackendContext {
  return { signal: new AbortController().signal, ...overrides }
}

function mockModel(text: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10 },
        outputTokens: { total: 5 },
        totalTokens: 15,
      },
      warnings: [],
    }),
  })
}

describe('createVercelAiBackend — capabilities', () => {
  it('declares prompt:true', () => {
    expect(createVercelAiBackend({ model: mockModel('hi') }).capabilities.prompt).toBe(true)
  })
  it('declares skills:true', () => {
    expect(createVercelAiBackend({ model: mockModel('hi') }).capabilities.skills).toBe(true)
  })
  it('declares toolPermissions:native', () => {
    expect(createVercelAiBackend({ model: mockModel('hi') }).capabilities.toolPermissions).toBe(
      'native',
    )
  })
  it('declares streaming:true (via streamText / onPartial)', () => {
    expect(createVercelAiBackend({ model: mockModel('hi') }).capabilities.streaming).toBe(true)
  })
  it('declares mcp:false (deferred)', () => {
    expect(createVercelAiBackend({ model: mockModel('hi') }).capabilities.mcp).toBe(false)
  })
  it('uses default id "vercel-ai"', () => {
    expect(createVercelAiBackend({ model: mockModel('hi') }).id).toBe('vercel-ai')
  })
  it('honors custom id', () => {
    expect(createVercelAiBackend({ id: 'custom', model: mockModel('hi') }).id).toBe('custom')
  })
})

describe('createVercelAiBackend — infer()', () => {
  it('returns text for a plain prompt', async () => {
    const backend = createVercelAiBackend({ model: mockModel('hello world') })
    const result = await backend.infer?.({ messages: [{ role: 'user', content: 'hi' }] }, makeCtx())
    expect(result?.text).toBe('hello world')
    expect(result?.structured).toBeUndefined()
  })

  it('routes through generateObject when outputSchema is set (F006: was parseStructured)', async () => {
    // Capture the responseFormat the SDK requests so we can assert that we
    // routed through generateObject's structured-output mode rather than
    // the old parseStructured-on-text fallback.
    let capturedResponseFormat: unknown
    const model = new MockLanguageModelV3({
      doGenerate: async (opts: { responseFormat?: unknown }) => {
        capturedResponseFormat = opts.responseFormat
        return {
          // generateObject expects raw JSON in the text content (no fence).
          content: [{ type: 'text', text: '{"answer":42}' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 }, totalTokens: 15 },
          warnings: [],
        }
      },
    })
    const backend = createVercelAiBackend({ model })
    const result = await backend.infer?.(
      {
        messages: [{ role: 'user', content: 'q' }],
        outputSchema: z.object({ answer: z.number() }),
      },
      makeCtx(),
    )
    expect(result?.structured).toEqual({ answer: 42 })
    expect(result?.text).toBeUndefined()
    // SDK requested structured output, not free-form text.
    expect((capturedResponseFormat as { type?: string })?.type).toBe('json')
  })

  it('reports usage from the model', async () => {
    const backend = createVercelAiBackend({ model: mockModel('ok') })
    const result = await backend.infer?.({ messages: [{ role: 'user', content: 'hi' }] }, makeCtx())
    expect(result?.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })
})

describe('createVercelAiBackend — run()', () => {
  it('returns text and stopReason from the model', async () => {
    const backend = createVercelAiBackend({ model: mockModel('greetings') })
    const result = await backend.run?.({ prompt: 'say hi' }, makeCtx())
    expect(result?.text).toBe('greetings')
    expect(result?.stopReason).toBe('stop')
  })

  it('returns structured value via Output.object when outputSchema is set (F006)', async () => {
    let capturedResponseFormat: unknown
    const model = new MockLanguageModelV3({
      doGenerate: async (opts: { responseFormat?: unknown }) => {
        capturedResponseFormat = opts.responseFormat
        return {
          content: [{ type: 'text', text: '{"action":"go"}' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 }, totalTokens: 15 },
          warnings: [],
        }
      },
    })
    const backend = createVercelAiBackend({ model })
    const result = await backend.run?.(
      {
        prompt: 'p',
        outputSchema: z.object({ action: z.string() }),
      },
      makeCtx(),
    )
    expect(result?.structured).toEqual({ action: 'go' })
    expect(result?.text).toBeUndefined()
    // Output.object adapter requested JSON-mode from the provider.
    expect((capturedResponseFormat as { type?: string })?.type).toBe('json')
  })

  it('does NOT request structured output when outputSchema is absent', async () => {
    let capturedResponseFormat: unknown
    const model = new MockLanguageModelV3({
      doGenerate: async (opts: { responseFormat?: unknown }) => {
        capturedResponseFormat = opts.responseFormat
        return {
          content: [{ type: 'text', text: 'plain text reply' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 }, totalTokens: 15 },
          warnings: [],
        }
      },
    })
    const backend = createVercelAiBackend({ model })
    const result = await backend.run?.({ prompt: 'p' }, makeCtx())
    expect(result?.text).toBe('plain text reply')
    expect(result?.structured).toBeUndefined()
    // Either no responseFormat, or the SDK's default 'text' mode.
    const fmt = (capturedResponseFormat as { type?: string })?.type
    expect(fmt === undefined || fmt === 'text').toBe(true)
  })

  it('passes options.systemPrompt + req.system + agentDef.instructions in order', async () => {
    let capturedSystem: string | undefined
    const model = new MockLanguageModelV3({
      doGenerate: async (opts: { prompt: Array<{ role: string; content: unknown }> }) => {
        const sys = opts.prompt.find((m) => m.role === 'system')
        capturedSystem = typeof sys?.content === 'string' ? sys.content : undefined
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 }, totalTokens: 2 },
          warnings: [],
        }
      },
    })

    const backend = createVercelAiBackend({ model, systemPrompt: 'BASE.' })
    await backend.run?.(
      {
        prompt: 'go',
        system: 'STEPSYS.',
        agentDef: { name: 'x', instructions: 'INSTR.' },
      },
      makeCtx(),
    )
    const baseIdx = capturedSystem?.indexOf('BASE.') ?? -1
    const instrIdx = capturedSystem?.indexOf('INSTR.') ?? -1
    const sysIdx = capturedSystem?.indexOf('STEPSYS.') ?? -1
    expect(baseIdx).toBeGreaterThanOrEqual(0)
    expect(baseIdx).toBeLessThan(instrIdx)
    expect(instrIdx).toBeLessThan(sysIdx)
  })
})
