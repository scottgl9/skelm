import { describe, expect, it } from 'vitest'
import { createOpencodeBackend } from '../src/backend.js'

describe('OpencodeBackend', () => {
  describe('createOpencodeBackend', () => {
    it('creates backend with default options', () => {
      const backend = createOpencodeBackend({})

      expect(backend.id).toBe('opencode')
      expect(backend.capabilities.prompt).toBe(true)
      expect(backend.capabilities.streaming).toBe(true)
      // Opencode manages its own permissions at the process level
      expect(backend.capabilities.toolPermissions).toBe('native')
    })

    it('creates backend with custom id and label', () => {
      const backend = createOpencodeBackend({
        id: 'custom-opencode',
        label: 'Custom Opencode Backend',
      })

      expect(backend.id).toBe('custom-opencode')
      expect(backend.label).toBe('Custom Opencode Backend')
    })

    it('creates backend with model selection capability when model is set', () => {
      const backend = createOpencodeBackend({
        model: 'llamacpp/qwen36',
      })
      expect(backend.capabilities.modelSelection).toBe(true)
    })

    it('has no model selection capability when model is unset', () => {
      const backend = createOpencodeBackend({})
      expect(backend.capabilities.modelSelection).toBe(false)
    })

    it('exposes run() method', () => {
      const backend = createOpencodeBackend({})
      expect(typeof backend.run).toBe('function')
    })
  })

  describe('capability flags', () => {
    it('reports sessionLifecycle: true', () => {
      expect(createOpencodeBackend({}).capabilities.sessionLifecycle).toBe(true)
    })

    it('reports mcp: true', () => {
      expect(createOpencodeBackend({}).capabilities.mcp).toBe(true)
    })
  })
})
