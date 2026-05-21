import { describe, expect, it } from 'vitest'
import { ModelRegistry } from '../../src/models/registry.js'
import type { ModelEntry } from '../../src/models/types.js'

const entry = (id: string, overrides: Partial<ModelEntry> = {}): ModelEntry => ({
  id,
  api: 'openai-completions',
  input: ['text'],
  contextWindow: 32_000,
  maxTokens: 4_096,
  cost: { input: 0, output: 0 },
  reasoning: false,
  ...overrides,
})

describe('ModelRegistry', () => {
  it('returns undefined when the provider is unknown', () => {
    const r = new ModelRegistry()
    expect(r.find('nope', 'anything')).toBeUndefined()
  })

  it('returns undefined when the model id is unknown for a known provider', () => {
    const r = new ModelRegistry()
    r.registerProvider('local', {
      baseUrl: 'http://localhost:8000/v1',
      models: [entry('a')],
    })
    expect(r.find('local', 'b')).toBeUndefined()
  })

  it('stitches together provider connection + matched model entry', () => {
    const r = new ModelRegistry()
    r.registerProvider('local', {
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'secret',
      headers: { 'X-Trace': '1' },
      models: [entry('qwen35', { name: 'Qwen 3.5', contextWindow: 131_072 })],
    })

    const resolved = r.find('local', 'qwen35')
    expect(resolved).toBeDefined()
    expect(resolved?.provider).toBe('local')
    expect(resolved?.baseUrl).toBe('http://localhost:8000/v1')
    expect(resolved?.apiKey).toBe('secret')
    expect(resolved?.headers).toEqual({ 'X-Trace': '1' })
    expect(resolved?.entry.name).toBe('Qwen 3.5')
    expect(resolved?.entry.contextWindow).toBe(131_072)
  })

  it('omits apiKey/headers from the resolved shape when not configured', () => {
    const r = new ModelRegistry()
    r.registerProvider('anon', {
      baseUrl: 'http://localhost:8000/v1',
      models: [entry('a')],
    })
    const resolved = r.find('anon', 'a')
    expect(resolved).toBeDefined()
    expect('apiKey' in (resolved ?? {})).toBe(false)
    expect('headers' in (resolved ?? {})).toBe(false)
  })

  it('re-registering a provider replaces its config (last write wins)', () => {
    const r = new ModelRegistry()
    r.registerProvider('p', { baseUrl: 'http://old', models: [entry('a')] })
    r.registerProvider('p', { baseUrl: 'http://new', models: [entry('b')] })
    expect(r.find('p', 'a')).toBeUndefined()
    expect(r.find('p', 'b')?.baseUrl).toBe('http://new')
  })

  it('supports multiple providers in the same registry', () => {
    const r = new ModelRegistry()
    r.registerProvider('cloud', { baseUrl: 'https://api.openai.com/v1', models: [entry('gpt')] })
    r.registerProvider('local', { baseUrl: 'http://localhost:8000/v1', models: [entry('qwen35')] })
    expect(r.find('cloud', 'gpt')?.baseUrl).toBe('https://api.openai.com/v1')
    expect(r.find('local', 'qwen35')?.baseUrl).toBe('http://localhost:8000/v1')
    expect(r.listProviders().sort()).toEqual(['cloud', 'local'])
  })

  it('hasProvider reports membership', () => {
    const r = new ModelRegistry()
    r.registerProvider('p', { baseUrl: 'http://x', models: [entry('a')] })
    expect(r.hasProvider('p')).toBe(true)
    expect(r.hasProvider('q')).toBe(false)
  })

  it('list() enumerates every (provider, model) pair', () => {
    const r = new ModelRegistry()
    r.registerProvider('p1', { baseUrl: 'http://1', models: [entry('a'), entry('b')] })
    r.registerProvider('p2', { baseUrl: 'http://2', models: [entry('c')] })
    const all = r
      .list()
      .map((e) => `${e.provider}/${e.model.id}`)
      .sort()
    expect(all).toEqual(['p1/a', 'p1/b', 'p2/c'])
  })

  it('carries reasoning + defaultThinkingLevel on the entry', () => {
    const r = new ModelRegistry()
    r.registerProvider('p', {
      baseUrl: 'http://x',
      models: [entry('r1', { reasoning: true, defaultThinkingLevel: 'deep' })],
    })
    const m = r.find('p', 'r1')?.entry
    expect(m?.reasoning).toBe(true)
    expect(m?.defaultThinkingLevel).toBe('deep')
  })

  it('returns a stable ordering of providers in listProviders()', () => {
    const r = new ModelRegistry()
    r.registerProvider('a', { baseUrl: 'http://a', models: [entry('x')] })
    r.registerProvider('b', { baseUrl: 'http://b', models: [entry('x')] })
    r.registerProvider('c', { baseUrl: 'http://c', models: [entry('x')] })
    expect(r.listProviders()).toEqual(['a', 'b', 'c'])
  })
})
