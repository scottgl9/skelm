/**
 * Unit tests for OpencodeProvider
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { OpencodeProvider, createOpencodeProvider } from '../src/provider.js'
import type { OpencodeProviderConfig } from '../src/provider.js'

// Mock fetch for health checks
global.fetch = vi.fn()

describe('OpencodeProvider', () => {
  let provider: OpencodeProvider

  beforeEach(() => {
    provider = createOpencodeProvider()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('should create provider with defaults', () => {
      expect(provider.id).toBe('opencode')
      expect(provider.name).toBe('Opencode.ai')
      expect(provider.version).toBe('1.0.0')
      expect(provider.type).toBe('provider')
    })

    it('should accept custom log level', () => {
      const customProvider = createOpencodeProvider({ logLevel: 'debug' })
      expect(customProvider.id).toBe('opencode')
    })
  })

  describe('capabilities', () => {
    it('should return provider capabilities', () => {
      const caps = provider.capabilities
      expect(caps.prompt).toBe(true)
      expect(caps.streaming).toBe(true)
      expect(caps.sessionLifecycle).toBe(true)
      expect(caps.mcp).toBe(true)
      expect(caps.toolPermissions).toBe('wrapped')
    })

    it('should include provider-specific capabilities', () => {
      const caps = provider.capabilities
      expect(caps.providerSpecific.structuredOutput).toBe(true)
      expect(caps.providerSpecific.reasoning).toBe(true)
      expect(caps.providerSpecific.toolCalling).toBe(true)
      expect(caps.providerSpecific.streaming).toBe(true)
    })

    it('should include pricing information', () => {
      const caps = provider.capabilities
      expect(caps.pricing?.inputPer1K).toBe(0)
      expect(caps.pricing?.outputPer1K).toBe(0)
    })

    it('should include context window info', () => {
      const caps = provider.capabilities
      expect(caps.maxContextWindow).toBe(128000)
      expect(caps.maxOutputTokens).toBe(4096)
    })
  })

  describe('initialize', () => {
    it('should initialize successfully with API key', async () => {
      const config: OpencodeProviderConfig = {
        apiKey: 'test-api-key',
        apiUrl: 'https://api.opencode.ai',
      }
      
      await provider.initialize(config)
      expect(provider.state).toBe('initialized')
    })

    it('should initialize from environment variable', async () => {
      vi.stubEnv('OPENCODE_API_KEY', 'env-api-key')
      
      const config: OpencodeProviderConfig = {}
      await provider.initialize(config)
      
      expect(provider.state).toBe('initialized')
      vi.unstubAllEnvs()
    })

    it('should throw when no API key provided', async () => {
      vi.unstubAllEnvs()
      
      const config: OpencodeProviderConfig = {}
      await expect(provider.initialize(config)).rejects.toThrow('API key is required')
    })

    it('should transition through states correctly', async () => {
      expect(provider.state).toBe('loading')
      
      await provider.initialize({ apiKey: 'test-key' })
      
      expect(provider.state).toBe('initialized')
    })
  })

  describe('createBackend', () => {
    beforeEach(async () => {
      await provider.initialize({ apiKey: 'test-key' })
    })

    it('should create backend with config', async () => {
      const backend = await provider.createBackend({
        timeout: 5000,
        maxRetries: 3,
      })
      
      expect(backend).toBeDefined()
    })

    it('should throw when not initialized', async () => {
      const newProvider = createOpencodeProvider()
      await expect(newProvider.createBackend()).rejects.toThrow('must be initialized')
    })

    it('should merge provider config with options', async () => {
      const backend = await provider.createBackend({
        timeout: 10000,
      })
      
      expect(backend).toBeDefined()
    })
  })

  describe('listModels', () => {
    beforeEach(async () => {
      await provider.initialize({ apiKey: 'test-key' })
    })

    it('should return list of models', async () => {
      const models = await provider.listModels()
      
      expect(models).toBeDefined()
      expect(models.length).toBeGreaterThan(0)
    })

    it('should include Qwen models', async () => {
      const models = await provider.listModels()
      const qwen35 = models.find(m => m.id === 'qwen35')
      const qwen36 = models.find(m => m.id === 'qwen36')
      
      expect(qwen35).toBeDefined()
      expect(qwen36).toBeDefined()
    })

    it('should include model capabilities', async () => {
      const models = await provider.listModels()
      const qwen35 = models.find(m => m.id === 'qwen35')
      
      expect(qwen35?.capabilities).toContain('file-ops')
      expect(qwen35?.capabilities).toContain('bash')
      expect(qwen35?.capabilities).toContain('reasoning')
    })

    it('should include context window info', async () => {
      const models = await provider.listModels()
      const qwen36 = models.find(m => m.id === 'qwen36')
      
      expect(qwen36?.contextWindow).toBe(262144)
    })
  })

  describe('healthCheck', () => {
    beforeEach(async () => {
      await provider.initialize({ apiKey: 'test-key' })
    })

    it('should return unhealthy when not initialized', async () => {
      const newProvider = createOpencodeProvider()
      const status = await newProvider.healthCheck()
      
      expect(status.healthy).toBe(false)
      expect(status.status).toBe('not-initialized')
    })

    it('should throw when no API key provided', async () => {
      const newProvider = createOpencodeProvider()
      await expect(newProvider.initialize({})).rejects.toThrow('API key is required')
      expect(newProvider.state).toBe('error')
    })

    it('should return healthy on successful API check', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response)

      const status = await provider.healthCheck()
      
      expect(status.healthy).toBe(true)
      expect(status.status).toBe('healthy')
    })

    it('should return unhealthy on API error', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response)

      const status = await provider.healthCheck()
      
      expect(status.healthy).toBe(false)
      expect(status.status).toContain('api-error')
    })

    it('should return unhealthy on network error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))

      const status = await provider.healthCheck()
      
      expect(status.healthy).toBe(false)
      expect(status.status).toBe('api-unreachable')
    })
  })

  describe('getMetadata', () => {
    it('should return provider metadata', () => {
      const metadata = provider.getMetadata()
      
      expect(metadata.id).toBe('opencode')
      expect(metadata.name).toBe('Opencode.ai')
      expect(metadata.version).toBe('1.0.0')
      expect(metadata.type).toBe('provider')
    })
  })

  describe('stop', () => {
    beforeEach(async () => {
      await provider.initialize({ apiKey: 'test-key' })
      await provider.start()
    })

    it('should transition to stopped state', async () => {
      await provider.stop()
      expect(provider.state).toBe('stopped')
    })

    it('should be idempotent', async () => {
      await provider.stop()
      await provider.stop()
      expect(provider.state).toBe('stopped')
    })
  })

  describe('error handling', () => {
    it('should wrap errors with provider context', async () => {
      const failingProvider = createOpencodeProvider()
      
      // Mock doInitialize to throw
      vi.spyOn(failingProvider as any, 'doInitialize').mockRejectedValue(
        new Error('Initialization failed')
      )

      try {
        await failingProvider.initialize({ apiKey: 'test-key' })
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('opencode')
        expect((error as Error).message).toContain('initialization')
      }
    })
  })
})
