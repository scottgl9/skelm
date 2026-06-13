import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createOllamaBackend } from '../src/backend.js'

describe('Ollama backend', () => {
  it('maps infer() onto the OpenAI-compatible /chat/completions surface', async () => {
    const requests: unknown[] = []
    const server = await startServer(async (req) => {
      requests.push(req)
      return {
        choices: [{ message: { content: 'hello from llama' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }
    })
    try {
      const backend = createOllamaBackend({ baseUrl: server.baseUrl })
      const response = await backend.infer?.(
        { system: 'be terse', messages: [{ role: 'user', content: 'say hi' }] },
        { signal: AbortSignal.timeout(5_000) },
      )
      expect(response?.text).toBe('hello from llama')
      expect(response?.usage).toEqual({
        inputTokens: 7,
        outputTokens: 3,
        extras: { totalTokens: 10 },
      })
      expect(requests).toEqual([
        expect.objectContaining({
          model: 'llama3.2',
          stream: false,
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

  it('parses structured responses when outputSchema is requested', async () => {
    const server = await startServer(async () => ({
      choices: [{ message: { content: '{"greeting":"hi"}' } }],
    }))
    try {
      const backend = createOllamaBackend({ baseUrl: server.baseUrl })
      const response = await backend.infer?.(
        {
          messages: [{ role: 'user', content: 'greet' }],
          outputSchema: z.object({ greeting: z.string() }),
        },
        { signal: AbortSignal.timeout(5_000) },
      )
      expect(response?.structured).toEqual({ greeting: 'hi' })
    } finally {
      await server.close()
    }
  })

  it('does not require an apiKey by default and only sets Authorization when one is configured', async () => {
    let sawAuthHeader = false
    const server = await startServer(async (_req, headers) => {
      sawAuthHeader = headers.authorization !== undefined
      return { choices: [{ message: { content: 'no auth needed' } }] }
    })
    try {
      const backend = createOllamaBackend({ baseUrl: server.baseUrl })
      const response = await backend.infer?.(
        { messages: [{ role: 'user', content: 'ping' }] },
        { signal: AbortSignal.timeout(5_000) },
      )
      expect(response?.text).toBe('no auth needed')
      expect(sawAuthHeader).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('throws a typed error on a non-2xx response', async () => {
    const server = await startServer(async () => ({ error: 'nope' }), 503)
    try {
      const backend = createOllamaBackend({ baseUrl: server.baseUrl })
      await expect(
        backend.infer?.(
          { messages: [{ role: 'user', content: 'x' }] },
          { signal: AbortSignal.timeout(5_000) },
        ),
      ).rejects.toThrow(/Ollama backend request failed/)
    } finally {
      await server.close()
    }
  })

  it('declares conservative default capabilities', () => {
    const backend = createOllamaBackend()
    expect(backend.capabilities.prompt).toBe(true)
    expect(backend.capabilities.streaming).toBe(false)
    expect(backend.capabilities.toolPermissions).toBe('unsupported')
  })
})

async function startServer(
  respond: (
    body: unknown,
    headers: Record<string, string | undefined>,
  ) => Promise<unknown> | unknown,
  status = 200,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const parsed = raw.length === 0 ? undefined : JSON.parse(raw)
    const headers: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? v[0] : v
    }
    const body = await respond(parsed, headers)
    res.writeHead(status, { 'Content-Type': 'application/json' })
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
