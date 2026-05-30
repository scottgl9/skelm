import { createServer } from 'node:http'
import type { SecretResolver, SkelmConfig } from '@skelm/core'
import { describe, expect, it, vi } from 'vitest'
import { buildBackendRegistry } from '../src/backends.js'

describe('buildBackendRegistry', () => {
  it('threads secretResolver into the OpenAI backend', async () => {
    const resolve = vi.fn(async (name: string) =>
      name === 'OPENAI_API_KEY' ? 'resolved-openai-key' : undefined,
    )
    const resolver: SecretResolver = { resolve }
    const server = await startJsonServer(async (_body, headers) => {
      expect(headers.authorization).toBe('Bearer resolved-openai-key')
      return {
        choices: [{ message: { content: 'ok' } }],
      }
    })

    try {
      const registry = await buildBackendRegistry(
        {
          backends: {
            openai: {
              baseUrl: server.baseUrl,
            },
          },
        } satisfies SkelmConfig,
        undefined,
        resolver,
      )

      const backend = registry?.resolveForLlm({ backendId: 'openai' })
      expect(backend).toBeDefined()
      const response = await backend?.inference?.(
        { messages: [{ role: 'user', content: 'hello' }] },
        { signal: new AbortController().signal },
      )

      expect(response?.text).toBe('ok')
      expect(resolve).toHaveBeenCalledWith('OPENAI_API_KEY')
    } finally {
      await server.close()
    }
  })

  it('threads secretResolver into the Anthropic backend', async () => {
    const resolve = vi.fn(async (name: string) =>
      name === 'ANTHROPIC_API_KEY' ? 'resolved-anthropic-key' : undefined,
    )
    const resolver: SecretResolver = { resolve }
    const server = await startJsonServer(async (_body, headers) => {
      expect(headers['x-api-key']).toBe('resolved-anthropic-key')
      return {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }
    })

    try {
      const registry = await buildBackendRegistry(
        {
          backends: {
            anthropic: {
              baseUrl: server.baseUrl,
            },
          },
        } satisfies SkelmConfig,
        undefined,
        resolver,
      )

      const backend = registry?.resolveForLlm({ backendId: 'anthropic' })
      expect(backend).toBeDefined()
      const response = await backend?.inference?.(
        { messages: [{ role: 'user', content: 'hello' }] },
        { signal: new AbortController().signal },
      )

      expect(response?.text).toBe('ok')
      expect(resolve).toHaveBeenCalledWith('ANTHROPIC_API_KEY')
    } finally {
      await server.close()
    }
  })
  it('registers the bundled @skelm/agent backend from config and sends its apiKey', async () => {
    const server = await startJsonServer(async (_body, headers) => {
      expect(headers.authorization).toBe('Bearer agent-key')
      return { choices: [{ message: { content: 'ok' } }] }
    })

    try {
      const registry = await buildBackendRegistry({
        backends: {
          'skelm-agent': {
            baseUrl: server.baseUrl,
            apiKey: 'agent-key',
          },
        },
      } satisfies SkelmConfig)

      const backend = registry?.resolveForLlm({ backendId: 'skelm-agent' })
      expect(backend).toBeDefined()
      const response = await backend?.inference?.(
        { messages: [{ role: 'user', content: 'hello' }] },
        { signal: new AbortController().signal },
      )

      expect(response?.text).toBe('ok')
    } finally {
      await server.close()
    }
  })

  it('resolves the @skelm/agent apiKey from an env secret reference', async () => {
    process.env.SKELM_AGENT_TEST_KEY = 'env-resolved-key'
    const server = await startJsonServer(async (_body, headers) => {
      expect(headers.authorization).toBe('Bearer env-resolved-key')
      return { choices: [{ message: { content: 'ok' } }] }
    })

    try {
      const registry = await buildBackendRegistry({
        backends: {
          'skelm-agent': {
            baseUrl: server.baseUrl,
            apiKey: { secret: 'SKELM_AGENT_TEST_KEY' },
          },
        },
      } satisfies SkelmConfig)

      const backend = registry?.resolveForLlm({ backendId: 'skelm-agent' })
      const response = await backend?.inference?.(
        { messages: [{ role: 'user', content: 'hello' }] },
        { signal: new AbortController().signal },
      )

      expect(response?.text).toBe('ok')
    } finally {
      await server.close()
      process.env.SKELM_AGENT_TEST_KEY = undefined
    }
  })
})

async function startJsonServer(
  respond: (
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
  ) => Promise<unknown> | unknown,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw.length === 0 ? undefined : JSON.parse(raw)
    const response = await respond(body, req.headers)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
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
