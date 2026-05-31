import { describe, expect, it, vi } from 'vitest'
import { BackendRegistry } from '../src/backend.js'
import { defineConfig } from '../src/config.js'
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

describe('defineConfig model alias validation', () => {
  it('warns when an alias backend is not declared in backends', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    defineConfig({
      backends: { openai: {} },
      models: {
        fast: { backend: 'openai', model: 'gpt-4o-mini' },   // ok
        oops: { backend: 'missing-backend', model: 'x' },    // should warn
      },
    })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('oops')
    expect(warn.mock.calls[0][0]).toContain('missing-backend')
    warn.mockRestore()
  })

  it('does not warn when all alias backends are declared', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    defineConfig({
      backends: { openai: {}, cheap: {} },
      models: {
        fast:  { backend: 'openai', model: 'gpt-4o-mini' },
        smart: { backend: 'cheap', model: 'gpt-3.5-turbo' },
        bare:  { model: 'some-model' },  // no backend field — always ok
      },
    })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not warn when models map is absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    defineConfig({ backends: { openai: {} } })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
