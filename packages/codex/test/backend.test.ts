import { describe, expect, it } from 'vitest'
import { createCodexBackend } from '../src/backend.js'

describe('CodexBackend (skeleton)', () => {
  it('reports the expected capabilities', () => {
    const backend = createCodexBackend()

    expect(backend.id).toBe('codex')
    expect(backend.capabilities.prompt).toBe(false)
    expect(backend.capabilities.streaming).toBe(true)
    expect(backend.capabilities.sessionLifecycle).toBe(true)
    expect(backend.capabilities.mcp).toBe(true)
    expect(backend.capabilities.skills).toBe(true)
    expect(backend.capabilities.toolPermissions).toBe('wrapped')
  })

  it('reports modelSelection: true only when model is set', () => {
    expect(createCodexBackend().capabilities.modelSelection).toBe(false)
    expect(createCodexBackend({ model: 'gpt-5.3-codex' }).capabilities.modelSelection).toBe(true)
  })

  it('honors id and label overrides', () => {
    const backend = createCodexBackend({ id: 'codex-fast', label: 'Codex (fast)' })
    expect(backend.id).toBe('codex-fast')
    expect(backend.label).toBe('Codex (fast)')
  })

  it('exposes a run() method', () => {
    expect(typeof createCodexBackend().run).toBe('function')
  })
})
