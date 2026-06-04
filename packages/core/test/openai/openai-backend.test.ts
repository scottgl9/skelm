import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BackendAuthenticationError,
  BackendConfigError,
  BackendNetworkError,
  BackendRateLimitError,
  BackendTimeoutError,
  BackendUpstreamError,
} from '../../src/backend.js'
import { createOpenAIBackend } from '../../src/openai/backend.js'

describe('OpenAI backend', () => {
  afterEach(() => {
    process.env.OPENAI_API_KEY = undefined
  })

  it('maps inference() to chat completions text responses', async () => {
    const requests: unknown[] = []
    const server = await startServer(async (req) => {
      requests.push(req)
      return {
        choices: [{ message: { content: 'hello from openai' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }
    })
    try {
      const backend = createOpenAIBackend({
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

      expect(response.text).toBe('hello from openai')
      expect(response.usage).toEqual({
        inputTokens: 12,
        outputTokens: 4,
        extras: { totalTokens: 16 },
      })
      expect(requests).toEqual([
        expect.objectContaining({
          model: 'gpt-4.1-mini',
          messages: [
            { role: 'system', content: 'be terse' },
            { role: 'user', content: 'say hi' },
          ],
        }),
      ])
    } finally {
      await server.close()
    }
  })

  it('forwards image content parts as data-URL image_url blocks', async () => {
    const requests: unknown[] = []
    const server = await startServer(async (req) => {
      requests.push(req)
      return { choices: [{ message: { content: 'I see a screenshot' } }] }
    })
    try {
      const backend = createOpenAIBackend({ apiKey: 'test-key', baseUrl: server.baseUrl })
      expect(backend.capabilities.vision).toBe(true)
      await backend.inference?.(
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'describe this' },
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
                { type: 'text', text: 'describe this' },
                {
                  type: 'image_url',
                  image_url: { url: 'data:image/png;base64,AAAA' },
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
      choices: [{ message: { content: '{"greeting":"hello"}' } }],
    }))
    try {
      const backend = createOpenAIBackend({
        apiKey: 'test-key',
        baseUrl: server.baseUrl,
      })
      const response = await backend.inference?.(
        {
          messages: [{ role: 'user', content: 'greet me' }],
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

  it('falls back to OPENAI_API_KEY when apiKey is omitted', async () => {
    process.env.OPENAI_API_KEY = 'from-env'
    const server = await startServer(async () => ({
      choices: [{ message: { content: 'env works' } }],
    }))
    try {
      const backend = createOpenAIBackend({ baseUrl: server.baseUrl })
      const response = await backend.inference?.(
        {
          messages: [{ role: 'user', content: 'ping' }],
        },
        { signal: AbortSignal.timeout(5_000) },
      )
      expect(response.text).toBe('env works')
      expect((backend as { effective?: string }).effective).toBe('env')
    } finally {
      await server.close()
    }
  })

  it('prefers explicit apiKey over the resolver and exposes the effective key', () => {
    const calls: string[] = []
    const backend = createOpenAIBackend({
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
    const backend = createOpenAIBackend({
      secretResolver: {
        async resolve(name) {
          calls.push(name)
          return 'from-resolver'
        },
      },
    })
    expect((backend as { apiKey?: string | null }).apiKey).toBe('from-resolver')
    expect((backend as { effective?: string | null }).effective).toBe('resolver')
    expect(calls).toEqual(['OPENAI_API_KEY'])
  })

  it('constructs without a key and defers BackendConfigError to first use', async () => {
    process.env.OPENAI_API_KEY = undefined
    // Construction must not throw — the gateway has to start out-of-box with
    // the default openai backend even when no key is configured.
    const backend = createOpenAIBackend({ baseUrl: 'http://127.0.0.1:1/v1' })
    expect(backend.id).toBe('openai')
    // The missing key surfaces only when the backend is actually invoked.
    await expect(
      backend.inference?.(
        { messages: [{ role: 'user', content: 'ping' }] },
        { signal: AbortSignal.timeout(5_000) },
      ),
    ).rejects.toBeInstanceOf(BackendConfigError)
  })

  it('classifies upstream authentication, rate-limit, timeout, and server errors', async () => {
    await expectOpenAIStatus(401, BackendAuthenticationError)
    await expectOpenAIStatus(403, BackendAuthenticationError)
    await expectOpenAIStatus(429, BackendRateLimitError)
    await expectOpenAIStatus(504, BackendTimeoutError)
    await expectOpenAIStatus(500, BackendUpstreamError)
  })

  it('classifies malformed upstream responses and invalid structured JSON as upstream errors', async () => {
    const malformed = createOpenAIBackend({
      apiKey: 'test-key',
      fetch: async () => new Response(JSON.stringify({ choices: 'wrong' }), { status: 200 }),
    })
    await expect(
      malformed.inference?.(
        { messages: [{ role: 'user', content: 'ping' }] },
        { signal: AbortSignal.timeout(5_000) },
      ),
    ).rejects.toBeInstanceOf(BackendUpstreamError)

    const invalidJson = createOpenAIBackend({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
          status: 200,
        }),
    })
    await expect(
      invalidJson.inference?.(
        {
          messages: [{ role: 'user', content: 'ping' }],
          outputSchema: z.object({ ok: z.boolean() }),
        },
        { signal: AbortSignal.timeout(5_000) },
      ),
    ).rejects.toBeInstanceOf(BackendUpstreamError)
  })

  it('classifies fetch failures as BackendNetworkError', async () => {
    const backend = createOpenAIBackend({
      apiKey: 'test-key',
      fetch: async () => {
        throw new Error('econnrefused')
      },
    })
    await expect(
      backend.inference?.(
        { messages: [{ role: 'user', content: 'ping' }] },
        { signal: AbortSignal.timeout(5_000) },
      ),
    ).rejects.toBeInstanceOf(BackendNetworkError)
  })
})

async function expectOpenAIStatus(
  status: number,
  klass: new (...args: never[]) => Error,
): Promise<void> {
  const backend = createOpenAIBackend({
    apiKey: 'test-key',
    fetch: async () =>
      new Response(JSON.stringify({ error: { message: `status ${status}` } }), {
        status,
        statusText: 'Nope',
      }),
  })
  await expect(
    backend.inference?.(
      { messages: [{ role: 'user', content: 'ping' }] },
      { signal: AbortSignal.timeout(5_000) },
    ),
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
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
