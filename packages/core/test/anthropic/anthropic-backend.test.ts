import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAnthropicBackend } from '../../src/anthropic/backend.js'
import {
  BackendAuthenticationError,
  BackendConfigError,
  BackendNetworkError,
  BackendRateLimitError,
  BackendTimeoutError,
  BackendUpstreamError,
} from '../../src/backend.js'

describe('Anthropic backend', () => {
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = undefined
    process.env.ANTHROPIC_BASE_URL = undefined
  })

  it('maps inference() to the messages API', async () => {
    const requests: unknown[] = []
    const server = await startServer(async (req) => {
      requests.push(req)
      return {
        content: [{ type: 'text', text: 'hello from anthropic' }],
        usage: { input_tokens: 9, output_tokens: 3 },
        stop_reason: 'end_turn',
      }
    })
    try {
      const backend = createAnthropicBackend({
        apiKey: 'test-key',
        baseUrl: server.baseUrl,
      })
      const response = await backend.inference?.(
        {
          system: 'be terse',
          messages: [{ role: 'user', content: 'say hi' }],
        },
        { signal: AbortSignal.timeout(5_000) },
      )

      expect(response.text).toBe('hello from anthropic')
      expect(response.usage).toEqual({
        inputTokens: 9,
        outputTokens: 3,
      })
      expect(requests).toEqual([
        expect.objectContaining({
          model: 'claude-3-5-haiku-latest',
          system: 'be terse',
          messages: [{ role: 'user', content: 'say hi' }],
        }),
      ])
    } finally {
      await server.close()
    }
  })

  it('supports one-shot agent() calls', async () => {
    const server = await startServer(async () => ({
      content: [{ type: 'text', text: 'agent reply' }],
      stop_reason: 'end_turn',
    }))
    try {
      const backend = createAnthropicBackend({
        apiKey: 'test-key',
        baseUrl: server.baseUrl,
      })
      const response = await backend.run?.(
        {
          prompt: 'investigate this',
        },
        { signal: AbortSignal.timeout(5_000) },
      )

      expect(response.text).toBe('agent reply')
      expect(response.stopReason).toBe('end_turn')
    } finally {
      await server.close()
    }
  })

  it('forwards image content parts as Anthropic image blocks', async () => {
    const requests: unknown[] = []
    const server = await startServer(async (req) => {
      requests.push(req)
      return {
        content: [{ type: 'text', text: 'I see a screenshot' }],
        stop_reason: 'end_turn',
      }
    })
    try {
      const backend = createAnthropicBackend({ apiKey: 'test-key', baseUrl: server.baseUrl })
      expect(backend.capabilities.vision).toBe(true)
      await backend.inference?.(
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'what is in this image?' },
                { type: 'image', mimeType: 'image/png', data: 'AAAA' },
              ],
            },
          ],
        },
        { signal: AbortSignal.timeout(5_000) },
      )

      expect(requests).toEqual([
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'what is in this image?' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                },
              ],
            },
          ],
        }),
      ])
    } finally {
      await server.close()
    }
  })

  it('run() forwards image content parts as Anthropic image blocks', async () => {
    const requests: unknown[] = []
    const server = await startServer(async (req) => {
      requests.push(req)
      return {
        content: [{ type: 'text', text: 'seen' }],
        stop_reason: 'end_turn',
      }
    })
    try {
      const backend = createAnthropicBackend({ apiKey: 'test-key', baseUrl: server.baseUrl })
      await backend.run?.(
        {
          prompt: [
            { type: 'text', text: 'describe' },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          ],
        },
        { signal: AbortSignal.timeout(5_000) },
      )

      expect(requests).toEqual([
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'describe' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                },
              ],
            },
          ],
        }),
      ])
    } finally {
      await server.close()
    }
  })

  it('parses structured responses when outputSchema is requested', async () => {
    const server = await startServer(async () => ({
      content: [{ type: 'text', text: '{"greeting":"hello"}' }],
      stop_reason: 'end_turn',
    }))
    try {
      const backend = createAnthropicBackend({
        apiKey: 'test-key',
        baseUrl: server.baseUrl,
      })
      const response = await backend.run?.(
        {
          prompt: 'greet me',
          outputSchema: z.object({ greeting: z.string() }),
        },
        { signal: AbortSignal.timeout(5_000) },
      )

      expect(response.structured).toEqual({ greeting: 'hello' })
      expect(response.text).toBe('{"greeting":"hello"}')
    } finally {
      await server.close()
    }
  })

  it('prefers explicit apiKey over the resolver and exposes the effective key', () => {
    const calls: string[] = []
    const backend = createAnthropicBackend({
      apiKey: 'explicit',
      secretResolver: {
        async resolve(name) {
          calls.push(name)
          return 'from-resolver'
        },
      },
    })
    expect((backend as { apiKey?: string | null }).apiKey).toBe('explicit')
    expect((backend as { effective?: string | null }).effective).toBe('explicit')
    expect(calls).toEqual([])
  })

  it('uses the resolver when apiKey is omitted', () => {
    const calls: string[] = []
    const backend = createAnthropicBackend({
      secretResolver: {
        async resolve(name) {
          calls.push(name)
          return 'from-resolver'
        },
      },
    })
    expect((backend as { apiKey?: string | null }).apiKey).toBe('from-resolver')
    expect((backend as { effective?: string | null }).effective).toBe('resolver')
    expect(calls).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('throws BackendConfigError when neither explicit, resolver, nor env key is available', () => {
    expect(() => createAnthropicBackend()).toThrow(BackendConfigError)
  })

  it('classifies upstream authentication, rate-limit, timeout, and server errors', async () => {
    await expectAnthropicStatus(401, BackendAuthenticationError)
    await expectAnthropicStatus(403, BackendAuthenticationError)
    await expectAnthropicStatus(429, BackendRateLimitError)
    await expectAnthropicStatus(504, BackendTimeoutError)
    await expectAnthropicStatus(500, BackendUpstreamError)
  })

  it('classifies malformed upstream responses and invalid structured JSON as upstream errors', async () => {
    const malformed = createAnthropicBackend({
      apiKey: 'test-key',
      fetch: async () => new Response(JSON.stringify({ content: 'wrong' }), { status: 200 }),
    })
    await expect(
      malformed.run?.({ prompt: 'ping' }, { signal: AbortSignal.timeout(5_000) }),
    ).rejects.toBeInstanceOf(BackendUpstreamError)

    const invalidJson = createAnthropicBackend({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'not json' }] }), {
          status: 200,
        }),
    })
    await expect(
      invalidJson.run?.(
        { prompt: 'ping', outputSchema: z.object({ ok: z.boolean() }) },
        { signal: AbortSignal.timeout(5_000) },
      ),
    ).rejects.toBeInstanceOf(BackendUpstreamError)
  })

  it('classifies fetch failures as BackendNetworkError', async () => {
    const backend = createAnthropicBackend({
      apiKey: 'test-key',
      fetch: async () => {
        throw new Error('econnrefused')
      },
    })
    await expect(
      backend.run?.({ prompt: 'ping' }, { signal: AbortSignal.timeout(5_000) }),
    ).rejects.toBeInstanceOf(BackendNetworkError)
  })
})

async function expectAnthropicStatus(
  status: number,
  klass: new (...args: never[]) => Error,
): Promise<void> {
  const backend = createAnthropicBackend({
    apiKey: 'test-key',
    fetch: async () =>
      new Response(JSON.stringify({ error: { message: `status ${status}` } }), {
        status,
        statusText: 'Nope',
      }),
  })
  await expect(
    backend.run?.({ prompt: 'ping' }, { signal: AbortSignal.timeout(5_000) }),
  ).rejects.toBeInstanceOf(klass)
}

async function startServer(
  respond: (body: unknown) => Promise<unknown> | unknown,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const parsed = raw.length === 0 ? undefined : JSON.parse(raw)
    const body = await respond(parsed)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('expected TCP server address')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
