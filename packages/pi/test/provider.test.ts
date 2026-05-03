/**
 * Unit tests for PiProvider
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { PiProvider, createPiProvider } from '../src/provider.js'
import type { PiProviderConfig } from '../src/provider.js'

// Mock child_process for PiProvider
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

const { execSync } = await import('child_process')

describe('PiProvider', () => {
  let provider: PiProvider

  beforeEach(() => {
    provider = createPiProvider()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('should create provider with defaults', () => {
      expect(provider.id).toBe('pi')
      expect(provider.name).toBe('Pi Coding Agent')
      expect(provider.version).toBe('1.0.0')
      expect(provider.type).toBe('provider')
    })

    it('should accept custom log level', () => {
      const customProvider = createPiProvider({ logLevel: 'debug' })
      expect(customProvider.id).toBe('pi')
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

    it('should include undefined pricing (depends on model)', () => {
      const caps = provider.capabilities
      expect(caps.pricing?.inputPer1K).toBeUndefined()
      expect(caps.pricing?.outputPer1K).toBeUndefined()
    })

    it('should include context window info', () => {
      const caps = provider.capabilities
      expect(caps.maxContextWindow).toBe(200000)
      expect(caps.maxOutputTokens).toBe(4096)
    })
  })

  describe('initialize', () => {
    it('should initialize with defaults', async () => {
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      
      const config: PiProviderConfig = {}
      await provider.initialize(config)
      
      expect(provider.state).toBe('initialized')
    })

    it('should accept custom command', async () => {
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      
      const config: PiProviderConfig = {
        command: '/custom/path/pi',
      }
      await provider.initialize(config)
      
      expect(provider.state).toBe('initialized')
    })

    it('should accept custom working directory', async () => {
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      
      const config: PiProviderConfig = {
        cwd: '/custom/cwd',
      }
      await provider.initialize(config)
      
      expect(provider.state).toBe('initialized')
    })

    it('should accept custom arguments', async () => {
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      
      const config: PiProviderConfig = {
        args: ['--verbose', '--debug'],
      }
      await provider.initialize(config)
      
      expect(provider.state).toBe('initialized')
    })

    it('should accept custom timeout', async () => {
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      
      const config: PiProviderConfig = {
        timeout: 600000,
      }
      await provider.initialize(config)
      
      expect(provider.state).toBe('initialized')
    })

    it('should transition through states correctly', async () => {
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      
      expect(provider.state).toBe('loading')
      await provider.initialize({})
      expect(provider.state).toBe('initialized')
    })
  })

  describe('createBackend', () => {
    beforeEach(async () => {
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      await provider.initialize({})
    })

    it('should create backend with config', async () => {
      const backend = await provider.createBackend({
        timeout: 5000,
        maxRetries: 3,
      })
      
      expect(backend).toBeDefined()
    })

    it('should throw when not initialized', async () => {
      const newProvider = createPiProvider()
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
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      await provider.initialize({})
    })

    it('should return list of models', async () => {
      const models = await provider.listModels()
      
      expect(models).toBeDefined()
      expect(models.length).toBeGreaterThan(0)
    })

    it('should include Claude models', async () => {
      const models = await provider.listModels()
      const sonnet = models.find(m => m.id === 'claude-3.5-sonnet')
      const opus = models.find(m => m.id === 'claude-3-opus')
      
      expect(sonnet).toBeDefined()
      expect(opus).toBeDefined()
    })

    it('should include GPT models', async () => {
      const models = await provider.listModels()
      const gpt4o = models.find(m => m.id === 'gpt-4o')
      const gpt4turbo = models.find(m => m.id === 'gpt-4-turbo')
      
      expect(gpt4o).toBeDefined()
      expect(gpt4turbo).toBeDefined()
    })

    it('should include model capabilities', async () => {
      const models = await provider.listModels()
      const sonnet = models.find(m => m.id === 'claude-3.5-sonnet')
      
      expect(sonnet?.capabilities).toContain('file-ops')
      expect(sonnet?.capabilities).toContain('bash')
      expect(sonnet?.capabilities).toContain('reasoning')
    })

    it('should include pricing information', async () => {
      const models = await provider.listModels()
      const sonnet = models.find(m => m.id === 'claude-3.5-sonnet')
      
      expect(sonnet?.pricing?.input).toBe(3)
      expect(sonnet?.pricing?.output).toBe(15)
    })

    it('should include context window info', async () => {
      const models = await provider.listModels()
      const sonnet = models.find(m => m.id === 'claude-3.5-sonnet')
      
      expect(sonnet?.contextWindow).toBe(200000)
    })
  })

  describe('healthCheck', () => {
    beforeEach(async () => {
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      await provider.initialize({})
    })

    it('should return unhealthy when not initialized', async () => {
      const newProvider = createPiProvider()
      const status = await newProvider.healthCheck()
      
      expect(status.healthy).toBe(false)
      expect(status.status).toBe('not-initialized')
    })

    it('should return healthy when pi is found', async () => {
      vi.mocked(execSync).mockReturnValue('pi 2.5.0\n')
      
      const status = await provider.healthCheck()
      
      expect(status.healthy).toBe(true)
      expect(status.status).toBe('healthy')
      expect(status.details?.version).toBe('pi 2.5.0')
    })

    it('should return unhealthy when pi is not found', async () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command not found')
      })
      
      const status = await provider.healthCheck()
      
      expect(status.healthy).toBe(false)
      expect(status.status).toBe('pi-not-found')
      expect(status.errors).toContain('Pi agent not found')
    })

    it('should handle execSync errors gracefully', async () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Permission denied')
      })
      
      const status = await provider.healthCheck()
      
      expect(status.healthy).toBe(false)
      expect(status.status).toBe('pi-not-found')
    })
  })

  describe('getMetadata', () => {
    it('should return provider metadata', () => {
      const metadata = provider.getMetadata()
      
      expect(metadata.id).toBe('pi')
      expect(metadata.name).toBe('Pi Coding Agent')
      expect(metadata.version).toBe('1.0.0')
      expect(metadata.type).toBe('provider')
    })
  })

  describe('stop', () => {
    beforeEach(async () => {
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      await provider.initialize({})
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
      const failingProvider = createPiProvider()
      
      // Mock doInitialize to throw
      vi.spyOn(failingProvider as any, 'doInitialize').mockRejectedValue(
        new Error('Initialization failed')
      )

      try {
        await failingProvider.initialize({})
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('pi')
        expect((error as Error).message).toContain('initialization')
      }
    })
  })

  describe('default config', () => {
    it('should have correct default command', async () => {
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      
      await provider.initialize({})
      
      // Verify default config was applied
      expect(provider.state).toBe('initialized')
    })

    it('should have correct default timeout', async () => {
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      
      await provider.initialize({})
      
      expect(provider.state).toBe('initialized')
    })

    it('should have correct default maxRetries', async () => {
      vi.mocked(execSync).mockReturnValue('pi 1.0.0\n')
      
      await provider.initialize({})
      
      expect(provider.state).toBe('initialized')
    })
  })
})
