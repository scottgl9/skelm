/**
 * Unit tests for ProviderCapabilityRegistry
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ProviderCapabilityRegistry } from '../src/providers/registry.js'
import type { ProviderCapabilities } from '../src/providers/base.js'

describe('ProviderCapabilityRegistry', () => {
  let registry: ProviderCapabilityRegistry

  beforeEach(() => {
    registry = new ProviderCapabilityRegistry()
  })

  describe('registerProvider', () => {
    it('should register a provider successfully', () => {
      const capabilities: ProviderCapabilities = {
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

      const models = [
        { id: 'model-1', name: 'Model 1', provider: 'test', capabilities: ['file-ops'] },
      ]

      registry.registerProvider('test-provider', 'Test Provider', capabilities, models)

      const provider = registry.getProvider('test-provider')
      expect(provider).toBeDefined()
      expect(provider?.id).toBe('test-provider')
      expect(provider?.name).toBe('Test Provider')
      expect(provider?.capabilities).toBe(capabilities)
      expect(provider?.models).toEqual(models)
      expect(provider?.health.healthy).toBe(true)
    })

    it('should index providers by capability', () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('provider-1', 'Provider 1', capabilities, [])
      registry.registerProvider('provider-2', 'Provider 2', capabilities, [])

      const providersWithStreaming = registry.findProvidersForCapability('streaming')
      expect(providersWithStreaming).toContain('provider-1')
      expect(providersWithStreaming).toContain('provider-2')
    })

    it('should index models', () => {
      const capabilities: ProviderCapabilities = {
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

      const models = [
        { id: 'model-1', name: 'Model 1', provider: 'test', capabilities: ['file-ops'] },
        { id: 'model-2', name: 'Model 2', provider: 'test', capabilities: ['bash'] },
      ]

      registry.registerProvider('test-provider', 'Test Provider', capabilities, models)

      expect(registry.getProviderForModel('model-1')).toBe('test-provider')
      expect(registry.getProviderForModel('model-2')).toBe('test-provider')
    })
  })

  describe('unregisterProvider', () => {
    it('should remove a provider', () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('test-provider', 'Test Provider', capabilities, [])
      registry.unregisterProvider('test-provider')

      expect(registry.getProvider('test-provider')).toBeUndefined()
    })

    it('should remove from capability index', () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('test-provider', 'Test Provider', capabilities, [])
      registry.unregisterProvider('test-provider')

      const providersWithStreaming = registry.findProvidersForCapability('streaming')
      expect(providersWithStreaming).not.toContain('test-provider')
    })

    it('should be idempotent', () => {
      registry.unregisterProvider('non-existent-provider')
      expect(registry.listProviders().length).toBe(0)
    })
  })

  describe('getProvider', () => {
    it('should return undefined for non-existent provider', () => {
      expect(registry.getProvider('non-existent')).toBeUndefined()
    })

    it('should return provider for existing ID', () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('test-provider', 'Test Provider', capabilities, [])
      const provider = registry.getProvider('test-provider')
      expect(provider).toBeDefined()
      expect(provider?.id).toBe('test-provider')
    })
  })

  describe('listProviders', () => {
    it('should return empty array when no providers registered', () => {
      expect(registry.listProviders()).toEqual([])
    })

    it('should return all registered providers', () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('provider-1', 'Provider 1', capabilities, [])
      registry.registerProvider('provider-2', 'Provider 2', capabilities, [])

      const providers = registry.listProviders()
      expect(providers.length).toBe(2)
      expect(providers.map(p => p.id)).toContain('provider-1', 'provider-2')
    })
  })

  describe('findProvidersForCapability', () => {
    it('should return empty array for non-existent capability', () => {
      expect(registry.findProvidersForCapability('non-existent')).toEqual([])
    })

    it('should return providers with the capability', () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('provider-1', 'Provider 1', capabilities, [])
      registry.registerProvider('provider-2', 'Provider 2', capabilities, [])

      const providers = registry.findProvidersForCapability('streaming')
      expect(providers).toContain('provider-1', 'provider-2')
    })
  })

  describe('findProviders', () => {
    const capabilities: ProviderCapabilities = {
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
      maxContextWindow: 128000,
      pricing: { inputPer1K: 0.01 },
    }

    beforeEach(() => {
      registry.registerProvider('provider-1', 'Provider 1', capabilities, [
        { id: 'model-1', name: 'Model 1', provider: 'test', capabilities: ['file-ops'] },
      ])
      registry.registerProvider('provider-2', 'Provider 2', capabilities, [
        { id: 'model-2', name: 'Model 2', provider: 'test', capabilities: ['bash'] },
      ])
    })

    it('should return all healthy providers when no filters', () => {
      const providers = registry.findProviders({})
      expect(providers).toContain('provider-1', 'provider-2')
    })

    it('should filter by required capabilities', () => {
      const providers = registry.findProviders({
        requiredCapabilities: ['streaming'],
      })
      expect(providers).toContain('provider-1', 'provider-2')
    })

    it('should filter by preferred providers', () => {
      const providers = registry.findProviders({
        preferredProviders: ['provider-1'],
      })
      expect(providers).toEqual(['provider-1'])
    })

    it('should filter by max cost', () => {
      const providers = registry.findProviders({
        maxCostPer1K: 0.01,
      })
      expect(providers).toContain('provider-1', 'provider-2')
    })

    it('should filter by min context window', () => {
      const providers = registry.findProviders({
        minContextWindow: 100000,
      })
      expect(providers).toContain('provider-1', 'provider-2')
    })

    it('should filter by specific model', () => {
      const providers = registry.findProviders({
        model: 'model-1',
      })
      expect(providers).toEqual(['provider-1'])
    })

    it('should filter by specific provider', () => {
      const providers = registry.findProviders({
        provider: 'provider-1',
      })
      expect(providers).toEqual(['provider-1'])
    })

    it('should exclude unhealthy providers', () => {
      registry.updateHealth('provider-1', { healthy: false, status: 'unhealthy' })
      const providers = registry.findProviders({})
      expect(providers).not.toContain('provider-1')
      expect(providers).toContain('provider-2')
    })
  })

  describe('getModels', () => {
    it('should return empty array for non-existent provider', () => {
      expect(registry.getModels('non-existent')).toEqual([])
    })

    it('should return models for existing provider', () => {
      const capabilities: ProviderCapabilities = {
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

      const models = [
        { id: 'model-1', name: 'Model 1', provider: 'test', capabilities: ['file-ops'] },
        { id: 'model-2', name: 'Model 2', provider: 'test', capabilities: ['bash'] },
      ]

      registry.registerProvider('test-provider', 'Test Provider', capabilities, models)
      expect(registry.getModels('test-provider')).toEqual(models)
    })
  })

  describe('getProviderForModel', () => {
    it('should return undefined for non-existent model', () => {
      expect(registry.getProviderForModel('non-existent')).toBeUndefined()
    })

    it('should return provider for existing model', () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('test-provider', 'Test Provider', capabilities, [
        { id: 'model-1', name: 'Model 1', provider: 'test', capabilities: ['file-ops'] },
      ])

      expect(registry.getProviderForModel('model-1')).toBe('test-provider')
    })
  })

  describe('updateHealth', () => {
    it('should update health status', () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('test-provider', 'Test Provider', capabilities, [])
      
      const newHealth = { healthy: false, status: 'error', errors: ['Test error'] }
      registry.updateHealth('test-provider', newHealth)

      const provider = registry.getProvider('test-provider')
      expect(provider?.health.healthy).toBe(false)
      expect(provider?.health.status).toBe('error')
      expect(provider?.health.errors).toEqual(['Test error'])
    })

    it('should be no-op for non-existent provider', () => {
      registry.updateHealth('non-existent', { healthy: false, status: 'error' })
      expect(registry.getProvider('non-existent')).toBeUndefined()
    })
  })

  describe('checkProviderHealth', () => {
    it('should call health check function and update status', async () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('test-provider', 'Test Provider', capabilities, [])

      const healthCheck = async () => ({
        healthy: true,
        status: 'healthy',
        details: { test: 'value' },
      })

      const result = await registry.checkProviderHealth('test-provider', healthCheck)
      expect(result.healthy).toBe(true)
      expect(result.status).toBe('healthy')
    })

    it('should handle health check errors', async () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('test-provider', 'Test Provider', capabilities, [])

      const healthCheck = async () => {
        throw new Error('Health check failed')
      }

      const result = await registry.checkProviderHealth('test-provider', healthCheck)
      expect(result.healthy).toBe(false)
      expect(result.status).toBe('error')
      expect(result.errors).toContain('Health check failed')
    })
  })

  describe('checkAllProvidersHealth', () => {
    it('should check all providers', async () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('provider-1', 'Provider 1', capabilities, [])
      registry.registerProvider('provider-2', 'Provider 2', capabilities, [])

      const healthChecks = new Map<string, () => Promise<any>>()
      healthChecks.set('provider-1', async () => ({ healthy: true, status: 'healthy' }))
      healthChecks.set('provider-2', async () => ({ healthy: true, status: 'healthy' }))

      const results = await registry.checkAllProvidersHealth(healthChecks)
      expect(results['provider-1']?.healthy).toBe(true)
      expect(results['provider-2']?.healthy).toBe(true)
    })

    it('should handle errors gracefully', async () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('provider-1', 'Provider 1', capabilities, [])

      const healthChecks = new Map<string, () => Promise<any>>()
      healthChecks.set('provider-1', async () => {
        throw new Error('Check failed')
      })

      const results = await registry.checkAllProvidersHealth(healthChecks)
      expect(results['provider-1']?.healthy).toBe(false)
      expect(results['provider-1']?.status).toBe('error')
    })
  })

  describe('getHealthyProviders', () => {
    it('should return only healthy providers', () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('provider-1', 'Provider 1', capabilities, [])
      registry.registerProvider('provider-2', 'Provider 2', capabilities, [])
      registry.updateHealth('provider-1', { healthy: false, status: 'unhealthy' })

      const healthy = registry.getHealthyProviders()
      expect(healthy).not.toContain('provider-1')
      expect(healthy).toContain('provider-2')
    })
  })

  describe('clear', () => {
    it('should remove all providers', () => {
      const capabilities: ProviderCapabilities = {
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

      registry.registerProvider('provider-1', 'Provider 1', capabilities, [])
      registry.registerProvider('provider-2', 'Provider 2', capabilities, [])

      registry.clear()

      expect(registry.listProviders()).toEqual([])
      expect(registry.getProvider('provider-1')).toBeUndefined()
    })
  })
})
