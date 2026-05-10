import { describe, it, expect } from 'vitest'

import { createSkelmAgentBackend } from '../src/index.js'
import { BackendRegistry } from '@skelm/core/backend'

function getDefaultBaseUrl(): string {
  return process.env.SKELM_AGENT_BASE_URL ?? 'http://localhost:8000'
}

describe('createSkelmAgentBackend', () => {
  it('creates a backend with correct id and capabilities', () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://localhost:8000',
      id: 'test-agent',
      label: 'Test Agent',
    })

    expect(backend.id).toBe('test-agent')
    expect(backend.capabilities.prompt).toBe(true)
    expect(backend.capabilities.streaming).toBe(false)
    expect(backend.capabilities.mcp).toBe(true)
    expect(backend.capabilities.skills).toBe(true)
    expect(backend.capabilities.modelSelection).toBe(true)
    expect(backend.capabilities.toolPermissions).toBe('native')
  })

  it('defaults id to "agent"', () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://localhost:8000',
    })
    expect(backend.id).toBe('agent')
  })
})

describe('SkelmAgentBackend — inference', () => {
  const backend = createSkelmAgentBackend({
    baseUrl: getDefaultBaseUrl(),
    model: 'qwen36',
  })

  it('responds to a simple prompt (single-shot)', async () => {
    const response = await backend.infer!(
      {
        messages: [{ role: 'user', content: 'What is 2 + 2? Answer with just the number.' }],
      },
      { signal: AbortSignal.timeout(60_000) },
    )

    expect(response.text).toBeDefined()
    expect(typeof response.text).toBe('string')
    expect(response.text.length).toBeGreaterThan(0)
  }, 65_000)

  it('supports structured output', async () => {
    const response = await backend.infer!(
      {
        messages: [{ role: 'user', content: 'Describe a cat in 3 adjectives.' }],
        outputSchema: {
          kind: 'object' as const,
          properties: {
            adjectives: {
              kind: 'array' as const,
              items: { kind: 'string' as const },
            },
          },
          required: ['adjectives'],
        } as never,
      },
      { signal: AbortSignal.timeout(60_000) },
    )

    expect(response.text).toBeDefined()
    expect(typeof response.text).toBe('string')
  }, 65_000)
})

describe('SkelmAgentBackend — agent loop', () => {
  const backend = createSkelmAgentBackend({
    baseUrl: getDefaultBaseUrl(),
    model: 'qwen36',
  })

  it('runs a simple agent step (single turn, no tools needed)', async () => {
    const response = await backend.run!(
      {
        prompt: 'Count from 1 to 3.',
        maxTurns: 5,
      },
      { signal: AbortSignal.timeout(90_000) },
    )

    expect(response.text).toBeDefined()
    expect(typeof response.text).toBe('string')
    expect(response.text).toContain('1')
    expect(response.text).toContain('2')
    expect(response.text).toContain('3')
  }, 95_000)

  it('uses fs_read tool to read a file', async () => {
    // Read the package.json itself
    const response = await backend.run!(
      {
        prompt: `Use the fs_read tool to read the file at "${process.cwd()}/packages/agent/package.json" and tell me the package name.`,
        maxTurns: 10,
      },
      { signal: AbortSignal.timeout(90_000) },
    )

    expect(response.text).toBeDefined()
    expect(typeof response.text).toBe('string')
    expect(response.text).toContain('@skelm/agent')
  }, 95_000)

  it('uses fs_write tool to write and verify', async () => {
    const testPath = `${process.cwd()}/packages/agent/test/_agent-test-output.txt`
    const writeResponse = await backend.run!(
      {
        prompt: `Use the fs_write tool to write the text "Hello from skelm agent!" to the file at "${testPath}".`,
        maxTurns: 10,
      },
      { signal: AbortSignal.timeout(90_000) },
    )

    expect(writeResponse.text).toBeDefined()

    // Verify the write worked by reading it back
    const readResponse = await backend.run!(
      {
        prompt: `Use the fs_read tool to read the file at "${testPath}" and tell me what it says.`,
        maxTurns: 10,
      },
      { signal: AbortSignal.timeout(90_000) },
    )

    expect(readResponse.text).toContain('Hello from skelm agent')

    // Cleanup
    await import('node:fs/promises').then((fs) =>
      fs.rm(testPath).catch(() => {}),
    )
  }, 120_000)

  it('uses ls tool to list workspace', async () => {
    const response = await backend.run!(
      {
        prompt: `Use the ls tool to list the current directory and tell me if you see a "packages" folder.`,
        maxTurns: 5,
      },
      { signal: AbortSignal.timeout(90_000) },
    )

    expect(response.text).toBeDefined()
    expect(typeof response.text).toBe('string')
    expect(response.text.toLowerCase()).toContain('packages')
  }, 95_000)

  it('rejects out-of-bounds path access', async () => {
    const response = await backend.run!(
      {
        prompt: `Try to read the file at "/etc/passwd" using fs_read.`,
        maxTurns: 5,
      },
      { signal: AbortSignal.timeout(90_000) },
    )

    expect(response.text).toBeDefined()
    // Should refuse the request (model may phrase the denial differently)
    expect(
      response.text.toLowerCase().includes('permission denied') ||
      response.text.toLowerCase().includes('escape') ||
      response.text.toLowerCase().includes('unable') ||
      response.text.toLowerCase().includes('cannot') ||
      response.text.toLowerCase().includes('denied') ||
      response.text.toLowerCase().includes('cannot access') ||
      response.text.toLowerCase().includes('outside') ||
      response.text.toLowerCase().includes('not allowed') ||
      response.text.toLowerCase().includes('unauthorized'),
    ).toBe(true)
  }, 95_000)

  it('rejects out-of-bounds network access', async () => {
    const response = await backend.run!(
      {
        prompt: `Try to fetch http://169.254.169.254/latest/meta-data/ using http_fetch.`,
        maxTurns: 5,
      },
      { signal: AbortSignal.timeout(90_000) },
    )

    expect(response.text).toBeDefined()
    // Should mention permission denied (since no network policy allows it)
    expect(
      response.text.toLowerCase().includes('permission denied') ||
      response.text.toLowerCase().includes('denied'),
    ).toBe(true)
  }, 95_000)

  it('handles multi-turn conversation with context', async () => {
    const response = await backend.run!(
      {
        prompt: `I'm thinking of a number between 1 and 100. Give me a hint about whether it's higher or lower than 50.`,
        maxTurns: 3,
      },
      { signal: AbortSignal.timeout(90_000) },
    )

    expect(response.text).toBeDefined()
    expect(typeof response.text).toBe('string')
    expect(response.text.length).toBeGreaterThan(10)
  }, 95_000)
})

describe('SkelmAgentBackend — integration with BackendRegistry', () => {
  it('registers and resolves the agent backend', () => {
    const registry = new BackendRegistry()
    const backend = createSkelmAgentBackend({
      baseUrl: getDefaultBaseUrl(),
      id: 'my-agent',
    })

    registry.register(backend)
    const resolved = registry.resolveForAgent({ backendId: 'my-agent' })
    expect(resolved).toBe(backend)
  })

  it('falls back to agent backend when no explicit backend', () => {
    const registry = new BackendRegistry()
    const backend = createSkelmAgentBackend({
      baseUrl: getDefaultBaseUrl(),
    })

    registry.register(backend)
    const resolved = registry.resolveForAgent({})
    expect(resolved.id).toBe('agent')
  })
})
