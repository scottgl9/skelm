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
      // biome-ignore lint/performance/noDelete: deterministic env cleanup in test teardown
      delete process.env.SKELM_AGENT_TEST_KEY
    }
  })

  it('forwards @skelm/agent custom headers from config', async () => {
    process.env.SKELM_AGENT_HEADER_TITLE = 'skelm-test'
    const server = await startJsonServer(async (_body, headers) => {
      expect(headers.authorization).toBe('Bearer agent-key')
      expect(headers['http-referer']).toBe('https://skelm.dev')
      expect(headers['x-openrouter-title']).toBe('skelm-test')
      return { choices: [{ message: { content: 'ok' } }] }
    })

    try {
      const registry = await buildBackendRegistry({
        backends: {
          'skelm-agent': {
            baseUrl: server.baseUrl,
            apiKey: 'agent-key',
            headers: {
              'HTTP-Referer': 'https://skelm.dev',
              'X-OpenRouter-Title': { secret: 'SKELM_AGENT_HEADER_TITLE' },
            },
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
      // biome-ignore lint/performance/noDelete: deterministic env cleanup in test teardown
      delete process.env.SKELM_AGENT_HEADER_TITLE
    }
  })

  it('threads secretResolver into @skelm-agent custom headers', async () => {
    const resolve = vi.fn(async (name: string) =>
      name === 'SKELM_AGENT_HEADER_TITLE' ? 'resolver-skelm-agent-title' : undefined,
    )
    const resolver: SecretResolver = { resolve }
    const server = await startJsonServer(async (_body, headers) => {
      expect(headers['x-openrouter-title']).toBe('resolver-skelm-agent-title')
      return { choices: [{ message: { content: 'ok' } }] }
    })

    try {
      const registry = await buildBackendRegistry(
        {
          backends: {
            'skelm-agent': {
              baseUrl: server.baseUrl,
              apiKey: 'agent-key',
              headers: {
                'X-OpenRouter-Title': { secret: 'SKELM_AGENT_HEADER_TITLE' },
              },
            },
          },
        } satisfies SkelmConfig,
        undefined,
        resolver,
      )

      const backend = registry?.resolveForLlm({ backendId: 'skelm-agent' })
      const response = await backend?.inference?.(
        { messages: [{ role: 'user', content: 'hello' }] },
        { signal: new AbortController().signal },
      )

      expect(response?.text).toBe('ok')
      expect(resolve).toHaveBeenCalledWith('SKELM_AGENT_HEADER_TITLE')
    } finally {
      await server.close()
    }
  })

  it('registers the pi backend id with the SDK backend from config', async () => {
    process.env.PI_TEST_KEY = 'pi-env-key'
    try {
      const registry = await buildBackendRegistry({
        backends: {
          pi: {
            provider: 'openai',
            model: 'qwen36',
            baseUrl: 'http://test.invalid/v1',
            apiKey: { secret: 'PI_TEST_KEY' },
            maxConcurrent: 1,
          },
        },
      } satisfies SkelmConfig)

      const backend = registry?.resolveForAgent({ backendId: 'pi' })
      expect(backend?.id).toBe('pi')
      expect(backend?.capabilities.toolPermissions).toBe('native')
      expect(backend?.capabilities.prompt).toBe(true)
      expect(typeof backend?.inference).toBe('function')
      expect(typeof backend?.run).toBe('function')
    } finally {
      process.env.PI_TEST_KEY = undefined
    }
  })

  it('rejects legacy pi RPC command config instead of ignoring it', async () => {
    await expect(
      buildBackendRegistry({
        backends: {
          pi: {
            command: '/custom/pi',
          },
        },
      } satisfies SkelmConfig),
    ).rejects.toThrow(/Pi RPC support has been removed/)
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
