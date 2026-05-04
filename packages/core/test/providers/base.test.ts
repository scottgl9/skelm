/**
 * Unit tests for ProviderPluginBase
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginConfig, PluginHealthStatus } from '../../src/plugins.js'
import {
  ProviderAuthenticationError,
  ProviderError,
  ProviderPluginBase,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from '../../src/providers/base.js'
import type { ProviderCapabilities } from '../../src/providers/base.js'

// Mock provider implementation for testing
class TestProvider extends ProviderPluginBase {
  private _capabilities: ProviderCapabilities

  constructor(
    options: {
      id?: string
      name?: string
      version?: string
      logLevel?: 'debug' | 'info' | 'warn' | 'error'
    } = {},
  ) {
    super({
      id: options.id ?? 'test-provider',
      name: options.name ?? 'Test Provider',
      version: options.version ?? '1.0.0',
      logLevel: options.logLevel,
    })
    this._capabilities = {
      prompt: true,
      streaming: true,
      sessionLifecycle: false,
      mcp: false,
      skills: false,
      modelSelection: true,
      toolPermissions: 'wrapped',
      providerSpecific: {
        structuredOutput: true,
        vision: false,
        reasoning: true,
        toolCalling: true,
        functionCalling: true,
        systemPrompts: true,
        multiTurn: true,
        streaming: true,
        contextCaching: false,
        parallelToolCalls: false,
      },
    }
  }

  get capabilities(): ProviderCapabilities {
    return this._capabilities
  }

  protected async doInitialize(config: PluginConfig): Promise<void> {
    // Simulate initialization
    if (config.failInitialization) {
      throw new Error('Initialization failed')
    }
  }

  async createBackend(config?: Record<string, unknown>): Promise<unknown> {
    return { id: 'test-backend' }
  }

  protected async doStart(): Promise<void> {
    if (this.config.failStart) {
      throw new Error('Start failed')
    }
  }

  protected async doStop(): Promise<void> {
    // Simulate cleanup
  }

  protected async doHealthCheck(): Promise<Partial<PluginHealthStatus>> {
    if (this.config.failHealthCheck) {
      return { healthy: false, status: 'unhealthy' }
    }
    return { healthy: true, status: 'healthy' }
  }
}

describe('ProviderPluginBase', () => {
  let provider: TestProvider

  beforeEach(() => {
    provider = new TestProvider()
  })

  describe('constructor', () => {
    it('should set default values', () => {
      expect(provider.type).toBe('provider')
      expect(provider.state).toBe('loading')
      expect(provider.id).toBe('test-provider')
      expect(provider.name).toBe('Test Provider')
      expect(provider.version).toBe('1.0.0')
    })

    it('should accept custom options', () => {
      const customProvider = new TestProvider({
        id: 'custom-id',
        name: 'Custom Name',
        version: '2.0.0',
        logLevel: 'debug',
      })
      expect(customProvider.id).toBe('custom-id')
      expect(customProvider.name).toBe('Custom Name')
      expect(customProvider.version).toBe('2.0.0')
    })
  })

  describe('initialize', () => {
    it('should transition through states correctly', async () => {
      expect(provider.state).toBe('loading')
      await provider.initialize({})
      expect(provider.state).toBe('initialized')
    })

    it('should validate and store config', async () => {
      const config = { apiKey: 'test-key', timeout: 5000 }
      await provider.initialize(config)
      // Config should be stored (protected, but we can verify through behavior)
      expect(provider.state).toBe('initialized')
    })

    it('should call doInitialize', async () => {
      const doInitializeSpy = vi.spyOn(provider, 'doInitialize')
      await provider.initialize({})
      expect(doInitializeSpy).toHaveBeenCalled()
    })

    it('should transition to error state on failure', async () => {
      await expect(provider.initialize({ failInitialization: true })).rejects.toThrow()
      expect(provider.state).toBe('error')
    })

    it('should wrap errors with provider context', async () => {
      try {
        await provider.initialize({ failInitialization: true })
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError)
        expect((error as ProviderError).message).toContain('test-provider')
        expect((error as ProviderError).message).toContain('initialization')
      }
    })
  })

  describe('start', () => {
    beforeEach(async () => {
      await provider.initialize({})
    })

    it('should transition to active state', async () => {
      expect(provider.state).toBe('initialized')
      await provider.start()
      expect(provider.state).toBe('active')
    })

    it('should call doStart', async () => {
      const doStartSpy = vi.spyOn(provider, 'doStart')
      await provider.start()
      expect(doStartSpy).toHaveBeenCalled()
    })

    it('should throw error if not initialized', async () => {
      const newProvider = new TestProvider()
      await expect(newProvider.start()).rejects.toThrow('must be initialized')
    })

    it('should be idempotent when already started', async () => {
      await provider.start()
      const initialTime = Date.now()
      await provider.start() // Should return early
      expect(provider.state).toBe('active')
    })

    it('should transition to error state on start failure', async () => {
      const failingProvider = new TestProvider()
      await failingProvider.initialize({})

      // Override doStart to throw
      vi.spyOn(failingProvider, 'doStart').mockRejectedValue(new Error('Start failed'))

      await expect(failingProvider.start()).rejects.toThrow()
      expect(failingProvider.state).toBe('error')
    })
  })

  describe('stop', () => {
    beforeEach(async () => {
      await provider.initialize({})
      await provider.start()
    })

    it('should transition to stopped state', async () => {
      expect(provider.state).toBe('active')
      await provider.stop()
      expect(provider.state).toBe('stopped')
    })

    it('should call doStop', async () => {
      const doStopSpy = vi.spyOn(provider, 'doStop')
      await provider.stop()
      expect(doStopSpy).toHaveBeenCalled()
    })

    it('should be idempotent when already stopped', async () => {
      await provider.stop()
      await provider.stop() // Should return early
      expect(provider.state).toBe('stopped')
    })

    it('should handle stop errors gracefully', async () => {
      const errorProvider = new TestProvider()
      await errorProvider.initialize({})
      await errorProvider.start()

      // Override doStop to throw
      vi.spyOn(errorProvider, 'doStop').mockRejectedValue(new Error('Stop failed'))

      await expect(errorProvider.stop()).rejects.toThrow()
      expect(errorProvider.state).toBe('error')
    })
  })

  describe('healthCheck', () => {
    it('should return unhealthy if not initialized', async () => {
      const newProvider = new TestProvider()
      const status = await newProvider.healthCheck()
      expect(status.healthy).toBe(false)
      expect(status.status).toBe('not-initialized')
    })

    it('should return error status if in error state', async () => {
      provider.state = 'error'
      provider.initialized = true // Ensure initialized is true so error state is checked
      const status = await provider.healthCheck()
      expect(status.healthy).toBe(false)
      expect(status.status).toBe('error')
    })

    it('should call doHealthCheck', async () => {
      await provider.initialize({})
      const doHealthCheckSpy = vi.spyOn(provider, 'doHealthCheck')
      await provider.healthCheck()
      expect(doHealthCheckSpy).toHaveBeenCalled()
    })

    it('should return healthy status on success', async () => {
      await provider.initialize({})
      const status = await provider.healthCheck()
      expect(status.healthy).toBe(true)
      expect(status.status).toBe('healthy')
    })

    it('should handle health check errors', async () => {
      await provider.initialize({ failHealthCheck: true })
      const status = await provider.healthCheck()
      expect(status.healthy).toBe(false)
      expect(status.status).toBe('unhealthy')
    })

    it('should include lastCheck timestamp', async () => {
      await provider.initialize({})
      const status = await provider.healthCheck()
      expect(status.lastCheck).toBeDefined()
      expect(new Date(status.lastCheck!).getTime()).toBeLessThanOrEqual(Date.now())
    })
  })

  describe('getMetadata', () => {
    it('should return provider metadata', () => {
      const metadata = provider.getMetadata()
      expect(metadata.id).toBe('test-provider')
      expect(metadata.name).toBe('Test Provider')
      expect(metadata.version).toBe('1.0.0')
      expect(metadata.type).toBe('provider')
    })
  })

  describe('withRetry', () => {
    it('should succeed on first attempt', async () => {
      const result = await provider.withRetry(async () => 'success')
      expect(result).toBe('success')
    })

    it('should retry on failure', async () => {
      let attempts = 0
      const result = await provider.withRetry(
        async () => {
          attempts++
          if (attempts < 3) throw new Error('Transient error')
          return 'success'
        },
        { maxRetries: 3, initialDelayMs: 10 },
      )

      expect(result).toBe('success')
      expect(attempts).toBe(3)
    })

    it('should stop retrying when max retries exceeded', async () => {
      let attempts = 0
      await expect(
        provider.withRetry(
          async () => {
            attempts++
            throw new Error('Permanent error')
          },
          { maxRetries: 2, initialDelayMs: 10 },
        ),
      ).rejects.toThrow('Permanent error')

      expect(attempts).toBe(3) // Initial + 2 retries
    })

    it('should respect retryable predicate', async () => {
      let attempts = 0
      await expect(
        provider.withRetry(
          async () => {
            attempts++
            throw new Error('Non-retryable error')
          },
          { maxRetries: 3, retryable: () => false },
        ),
      ).rejects.toThrow('Non-retryable error')

      expect(attempts).toBe(1) // No retries
    })

    it('should apply exponential backoff', async () => {
      const times: number[] = []
      await provider.withRetry(
        async () => {
          times.push(Date.now())
          if (times.length < 3) throw new Error('Error')
          return 'success'
        },
        { maxRetries: 3, initialDelayMs: 50, backoffFactor: 2 },
      )

      // Check that delays increased
      const delay1 = times[1] - times[0]
      const delay2 = times[2] - times[1]
      expect(delay2).toBeGreaterThan(delay1)
    })
  })

  describe('error types', () => {
    it('ProviderError should extend Error', () => {
      const error = new ProviderError('test message')
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe('ProviderError')
    })

    it('ProviderAuthenticationError should extend ProviderError', () => {
      const error = new ProviderAuthenticationError('auth failed')
      expect(error).toBeInstanceOf(ProviderError)
      expect(error.name).toBe('ProviderAuthenticationError')
    })

    it('ProviderRateLimitError should include retryAfter', () => {
      const error = new ProviderRateLimitError('rate limited', undefined, 60)
      expect(error).toBeInstanceOf(ProviderError)
      expect(error.name).toBe('ProviderRateLimitError')
      expect(error.retryAfter).toBe(60)
    })

    it('ProviderTimeoutError should extend ProviderError', () => {
      const error = new ProviderTimeoutError('timeout')
      expect(error).toBeInstanceOf(ProviderError)
      expect(error.name).toBe('ProviderTimeoutError')
    })
  })
})
