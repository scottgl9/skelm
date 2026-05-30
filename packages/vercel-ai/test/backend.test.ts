import type { BackendContext } from '@skelm/core'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
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

describe('createVercelAiBackend — inference()', () => {
  it('returns text for a plain prompt', async () => {
    const backend = createVercelAiBackend({ model: mockModel('hello world') })
    const result = await backend.inference?.(
      { messages: [{ role: 'user', content: 'hi' }] },
      makeCtx(),
    )
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
    const result = await backend.inference?.(
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
    const result = await backend.inference?.(
      { messages: [{ role: 'user', content: 'hi' }] },
      makeCtx(),
    )
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

  it('streams text chunks through onPartial when context.onPartial is provided', async () => {
    // Mock the V3 streaming protocol with three text-delta chunks.
    const chunks = ['Hello, ', 'streaming ', 'world!']
    const streamParts = [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't1' },
      ...chunks.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
      { type: 'text-end' as const, id: 't1' },
      {
        type: 'finish' as const,
        usage: { inputTokens: 3, outputTokens: 6, totalTokens: 9 },
        finishReason: 'stop' as const,
      },
    ]
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream(streamParts),
      }),
    })
    const backend = createVercelAiBackend({ model })

    const received: string[] = []
    const result = await backend.run?.(
      { prompt: 'stream me' },
      { ...makeCtx(), onPartial: (c: string) => received.push(c) },
    )

    expect(received).toEqual(chunks)
    expect(result?.text).toBe(chunks.join(''))
    // finishReason / usage normalization through the streaming path are tested
    // in the generateText tests above; here we just verify the streaming
    // contract: every text-delta chunk reaches onPartial and the final text
    // matches the concatenation.
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

describe('createVercelAiBackend — visionModels allowlist (F123)', () => {
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  const imageMsg = {
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: 'describe' },
      { type: 'image' as const, mimeType: 'image/png', data: PNG },
    ],
  }

  it('throws BackendCapabilityError on inference() when model not in visionModels', async () => {
    const model = mockModel('would-have-hallucinated')
    const backend = createVercelAiBackend({
      model,
      visionModels: ['qwen2.5-vl', 'gpt-4o'],
    })
    await expect(backend.inference?.({ messages: [imageMsg] }, makeCtx())).rejects.toThrow(
      /visionModels allowlist/,
    )
  })

  it('throws BackendCapabilityError on run() when model not in visionModels', async () => {
    const model = mockModel('hallucinated')
    const backend = createVercelAiBackend({
      model,
      visionModels: ['qwen2.5-vl'],
    })
    await expect(backend.run?.({ prompt: imageMsg.content }, makeCtx())).rejects.toThrow(
      /does not support image content/,
    )
  })

  it('passes when model id is in visionModels (allowlist hit)', async () => {
    // MockLanguageModelV3 default modelId is 'mock-model-id'; allow that.
    const model = mockModel('saw the image')
    const backend = createVercelAiBackend({
      model,
      visionModels: ['mock-model-id'],
    })
    const result = await backend.run?.({ prompt: imageMsg.content }, makeCtx())
    expect(result?.text).toBe('saw the image')
  })

  it('passes when the provider:modelId form is in visionModels', async () => {
    // MockLanguageModelV3 exposes `provider: 'mock-provider'` and
    // `modelId: 'mock-model-id'`; allowlist with the qualified form must
    // match (disambiguates models that exist under multiple providers).
    const model = mockModel('saw the image via provider:id')
    const backend = createVercelAiBackend({
      model,
      visionModels: ['mock-provider:mock-model-id'],
    })
    const result = await backend.run?.({ prompt: imageMsg.content }, makeCtx())
    expect(result?.text).toBe('saw the image via provider:id')
  })

  it('error message uses provider:modelId form when provider is available', async () => {
    const model = mockModel('hallucinated')
    const backend = createVercelAiBackend({
      model,
      visionModels: ['only-vision-model'],
    })
    await expect(backend.run?.({ prompt: imageMsg.content }, makeCtx())).rejects.toThrow(
      /mock-provider:mock-model-id/,
    )
  })

  it('is a no-op when visionModels is unset (preserves prior behavior)', async () => {
    const model = mockModel('legacy path')
    const backend = createVercelAiBackend({ model })
    const result = await backend.run?.({ prompt: imageMsg.content }, makeCtx())
    expect(result?.text).toBe('legacy path')
  })

  it('does not reject text-only prompts even when allowlist is set', async () => {
    const model = mockModel('plain text')
    const backend = createVercelAiBackend({
      model,
      visionModels: ['only-this-one'],
    })
    const result = await backend.run?.({ prompt: 'hi' }, makeCtx())
    expect(result?.text).toBe('plain text')
  })
})

describe('createVercelAiBackend — per-call model override guard (F133)', () => {
  it('throws BackendCapabilityError on inference() when req.model differs from bound model', async () => {
    const backend = createVercelAiBackend({ model: mockModel('bound-reply') })
    await expect(
      backend.inference?.(
        { messages: [{ role: 'user', content: 'hi' }], model: 'some-other-model' },
        makeCtx(),
      ),
    ).rejects.toThrow(/cannot honour per-call model overrides/)
  })

  it('passes inference() when req.model matches bound model id', async () => {
    const backend = createVercelAiBackend({ model: mockModel('bound-reply') })
    const result = await backend.inference?.(
      { messages: [{ role: 'user', content: 'hi' }], model: 'mock-model-id' },
      makeCtx(),
    )
    expect(result?.text).toBe('bound-reply')
  })

  it('passes inference() when req.model matches the provider:modelId form', async () => {
    const backend = createVercelAiBackend({ model: mockModel('bound-reply') })
    const result = await backend.inference?.(
      { messages: [{ role: 'user', content: 'hi' }], model: 'mock-provider:mock-model-id' },
      makeCtx(),
    )
    expect(result?.text).toBe('bound-reply')
  })

  it('is a no-op when req.model is undefined (preserves prior behavior)', async () => {
    const backend = createVercelAiBackend({ model: mockModel('bound-reply') })
    const result = await backend.inference?.(
      { messages: [{ role: 'user', content: 'hi' }] },
      makeCtx(),
    )
    expect(result?.text).toBe('bound-reply')
  })

  it('error message names both bound model and requested model', async () => {
    const backend = createVercelAiBackend({ model: mockModel('bound-reply') })
    await expect(
      backend.inference?.(
        { messages: [{ role: 'user', content: 'hi' }], model: 'qwen3-8b' },
        makeCtx(),
      ),
    ).rejects.toThrow(/bound to model "mock-provider:mock-model-id".*requested "qwen3-8b"/)
  })

  it('thrown BackendCapabilityError carries capability="modelSelection" (review fix)', async () => {
    // A model-routing mismatch is NOT a vision-capability failure —
    // callers branching on .capability='vision' would misclassify this.
    // vercel-ai declares modelSelection:false in its BackendCapabilities,
    // which is exactly the contract this guard enforces.
    const backend = createVercelAiBackend({ model: mockModel('bound-reply') })
    try {
      await backend.inference?.(
        { messages: [{ role: 'user', content: 'hi' }], model: 'qwen3-8b' },
        makeCtx(),
      )
      expect.fail('expected BackendCapabilityError to be thrown')
    } catch (err) {
      const e = err as { name?: string; capability?: string; backendId?: string }
      expect(e.name).toBe('BackendCapabilityError')
      expect(e.capability).toBe('modelSelection')
      expect(e.backendId).toBe('vercel-ai')
    }
  })
})
