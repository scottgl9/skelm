import { describe, expect, it } from 'vitest'
import { BackendRegistry } from '../src/backend.js'
import type { ModelAliasEntry } from '../src/config.js'
import type { InferenceRequest, InferenceResponse, SkelmBackend } from '../src/backend.js'

function makeMockBackend(id: string): SkelmBackend & { lastReq: InferenceRequest | undefined } {
  let lastReq: InferenceRequest | undefined
  return {
    id,
    capabilities: { prompt: true },
    async inference(req: InferenceRequest): Promise<InferenceResponse> {
      lastReq = req
      return { text: `ok:${req.model ?? 'no-model'}` }
    },
    get lastReq() {
      return lastReq
    },
  } as unknown as SkelmBackend & { lastReq: InferenceRequest | undefined }
}

describe('BackendRegistry model aliases', () => {
  it('resolveModelAlias returns undefined for an unknown name', () => {
    const reg = new BackendRegistry()
    expect(reg.resolveModelAlias('fast')).toBeUndefined()
  })

  it('resolveModelAlias returns the entry when the alias is registered', () => {
    const models: Record<string, ModelAliasEntry> = {
      fast: { backend: 'openai', model: 'gpt-4o-mini' },
      smart: { model: 'gpt-4o' },
    }
    const reg = new BackendRegistry({ models })
    expect(reg.resolveModelAlias('fast')).toEqual({ backend: 'openai', model: 'gpt-4o-mini' })
    expect(reg.resolveModelAlias('smart')).toEqual({ model: 'gpt-4o' })
  })

  it('resolveModelAlias returns undefined for a bare model string (non-alias)', () => {
    const reg = new BackendRegistry({ models: { fast: { model: 'gpt-4o-mini' } } })
    // 'gpt-4o-mini' is not a registered alias name
    expect(reg.resolveModelAlias('gpt-4o-mini')).toBeUndefined()
  })

  it('alias without backend field does not change backend resolution', () => {
    const models: Record<string, ModelAliasEntry> = {
      smart: { model: 'gpt-4o' },
    }
    const reg = new BackendRegistry({ models })
    const backend = makeMockBackend('openai')
    reg.register(backend)
    // Backend resolves normally; alias only carries model
    const resolved = reg.resolveForLlm({ backendId: undefined })
    expect(resolved.id).toBe('openai')
    const alias = reg.resolveModelAlias('smart')
    expect(alias?.model).toBe('gpt-4o')
    expect(alias?.backend).toBeUndefined()
  })

  it('alias with backend field resolves to the named backend', () => {
    const models: Record<string, ModelAliasEntry> = {
      fast: { backend: 'cheap', model: 'gpt-4o-mini' },
    }
    const reg = new BackendRegistry({ models })
    const cheap = makeMockBackend('cheap')
    const expensive = makeMockBackend('expensive')
    reg.register(cheap)
    reg.register(expensive)

    const alias = reg.resolveModelAlias('fast')
    expect(alias?.backend).toBe('cheap')
    const backend = reg.resolveForLlm({ backendId: alias?.backend })
    expect(backend.id).toBe('cheap')
  })
})
