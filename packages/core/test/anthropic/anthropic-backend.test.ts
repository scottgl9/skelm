import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAnthropicBackend } from '../../src/anthropic/backend.js'

describe('Anthropic backend', () => {
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = undefined
    process.env.ANTHROPIC_BASE_URL = undefined
  })

  it('maps infer() to the messages API', async () => {
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
      const response = await backend.infer?.(
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
})

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
