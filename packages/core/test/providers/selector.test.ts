/**
 * Unit tests for ProviderSelector
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ProviderCapabilityRegistry } from '../src/providers/registry.js'
import { selectProviderForTask, selectProvider, ProviderSelectionError } from '../src/providers/selector.js'
import type { TaskRequirements, ProviderSelection } from '../src/providers/selector.js'
import type { ProviderCapabilities } from '../src/providers/base.js'

function createTestRegistry(): ProviderCapabilityRegistry {
  const registry = new ProviderCapabilityRegistry()
  
  const capabilities: ProviderCapabilities = {
    prompt: true,
    streaming: true,
    sessionLifecycle: true,
    mcp: true,
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
      parallelToolCalls: true,
    },
    maxContextWindow: 128000,
    maxOutputTokens: 4096,
    pricing: { inputPer1K: 0.01, outputPer1K: 0.03 },
  }

  registry.registerProvider('provider-1', 'Provider 1', capabilities, [
    { id: 'model-1', name: 'Model 1', provider: 'provider-1', capabilities: ['file-ops', 'bash'] },
    { id: 'model-2', name: 'Model 2', provider: 'provider-1', capabilities: ['code-review'] },
  ])

  registry.registerProvider('provider-2', 'Provider 2', capabilities, [
    { id: 'model-3', name: 'Model 3', provider: 'provider-2', capabilities: ['file-ops', 'reasoning'] },
  ])

  return registry
}

describe('ProviderSelector', () => {
  let registry: ProviderCapabilityRegistry

  beforeEach(() => {
    registry = createTestRegistry()
  })

  describe('selectProviderForTask', () => {
    it('should select a provider when no specific requirements', () => {
      const requirements: TaskRequirements = {}
      const result = selectProviderForTask(requirements, registry)

      expect(result.providerId).toBeDefined()
      expect(result.reason).toBeDefined()
      expect(result.alternatives).toBeDefined()
    })

    it('should select provider with specific model', () => {
      const requirements: TaskRequirements = {
        model: 'model-1',
      }
      const result = selectProviderForTask(requirements, registry)

      expect(result.providerId).toBe('provider-1')
      expect(result.modelId).toBe('model-1')
    })

    it('should select provider with specific provider ID', () => {
      const requirements: TaskRequirements = {
        provider: 'provider-2',
      }
      const result = selectProviderForTask(requirements, registry)

      expect(result.providerId).toBe('provider-2')
    })

    it('should filter by required capabilities', () => {
      const requirements: TaskRequirements = {
        requiredCapabilities: ['streaming', 'toolCalling'],
      }
      const result = selectProviderForTask(requirements, registry)

      expect(result.providerId).toBeDefined()
      expect(result.providerId).toBeOneOf(['provider-1', 'provider-2'])
    })

    it('should prefer providers from preferred list', () => {
      const requirements: TaskRequirements = {
        preferredProviders: ['provider-2', 'provider-1'],
      }
      const result = selectProviderForTask(requirements, registry)

      expect(result.providerId).toBe('provider-2')
    })

    it('should filter by max cost', () => {
      const requirements: TaskRequirements = {
        maxCostPer1K: 0.02,
      }
      const result = selectProviderForTask(requirements, registry)

      expect(result.providerId).toBeDefined()
    })

    it('should filter by min context window', () => {
      const requirements: TaskRequirements = {
        minContextWindow: 100000,
      }
      const result = selectProviderForTask(requirements, registry)

      expect(result.providerId).toBeDefined()
    })

    it('should exclude unhealthy providers', () => {
      registry.updateHealth('provider-1', { healthy: false, status: 'unhealthy' })
      
      const requirements: TaskRequirements = {}
      const result = selectProviderForTask(requirements, registry)

      expect(result.providerId).not.toBe('provider-1')
    })

    it('should return alternatives', () => {
      const requirements: TaskRequirements = {}
      const result = selectProviderForTask(requirements, registry)

      expect(result.alternatives).toBeDefined()
      expect(result.alternatives.length).toBeGreaterThan(0)
      expect(result.alternatives).not.toContain(result.providerId)
    })

    it('should determine selection reason', () => {
      const requirements: TaskRequirements = {
        provider: 'provider-1',
      }
      const result = selectProviderForTask(requirements, registry)

      expect(result.reason).toContain('Explicit provider selection')
    })

    it('should include model in reason when specified', () => {
      const requirements: TaskRequirements = {
        model: 'model-1',
      }
      const result = selectProviderForTask(requirements, registry)

      expect(result.reason).toContain('Model model-1 available')
    })
  })

  describe('best effort selection', () => {
    it('should fall back when no exact match found', () => {
      const requirements: TaskRequirements = {
        requiredCapabilities: ['non-existent-capability'],
      }
      const result = selectProviderForTask(requirements, registry)

      expect(result.providerId).toBeDefined()
      expect(result.reason).toContain('Best effort selection')
    })

    it('should throw when no healthy providers available', () => {
      registry.updateHealth('provider-1', { healthy: false, status: 'unhealthy' })
      registry.updateHealth('provider-2', { healthy: false, status: 'unhealthy' })

      const requirements: TaskRequirements = {}
      expect(() => selectProviderForTask(requirements, registry)).toThrow(ProviderSelectionError)
    })
  })

  describe('cost optimization', () => {
    it('should sort by cost when costOptimized is true', () => {
      const cheapCapabilities: ProviderCapabilities = {
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
        pricing: { inputPer1K: 0.005 },
      }

      const expensiveCapabilities: ProviderCapabilities = {
        ...cheapCapabilities,
        pricing: { inputPer1K: 0.05 },
      }

      const testRegistry = new ProviderCapabilityRegistry()
      testRegistry.registerProvider('cheap-provider', 'Cheap Provider', cheapCapabilities, [
        { id: 'cheap-model', name: 'Cheap Model', provider: 'cheap', capabilities: [] },
      ])
      testRegistry.registerProvider('expensive-provider', 'Expensive Provider', expensiveCapabilities, [
        { id: 'expensive-model', name: 'Expensive Model', provider: 'expensive', capabilities: [] },
      ])

      const requirements: TaskRequirements = {
        costOptimized: true,
      }
      const result = selectProviderForTask(requirements, testRegistry)

      expect(result.providerId).toBe('cheap-provider')
    })
  })

  describe('model selection', () => {
    it('should select best model when not specified', () => {
      const requirements: TaskRequirements = {
        provider: 'provider-1',
      }
      const result = selectProviderForTask(requirements, registry)

      expect(result.providerId).toBe('provider-1')
      expect(result.modelId).toBeDefined()
      expect(result.modelId).toBeOneOf(['model-1', 'model-2'])
    })

    it('should respect min context window in model selection', () => {
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
        maxContextWindow: 200000,
      }

      const testRegistry = new ProviderCapabilityRegistry()
      testRegistry.registerProvider('provider', 'Provider', capabilities, [
        { id: 'small-model', name: 'Small Model', provider: 'test', contextWindow: 50000, capabilities: [] },
        { id: 'large-model', name: 'Large Model', provider: 'test', contextWindow: 200000, capabilities: [] },
      ])

      const requirements: TaskRequirements = {
        provider: 'provider',
        minContextWindow: 100000,
      }
      const result = selectProviderForTask(requirements, testRegistry)

      expect(result.modelId).toBe('large-model')
    })

    it('should throw when no models available', () => {
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

      const testRegistry = new ProviderCapabilityRegistry()
      testRegistry.registerProvider('provider', 'Provider', capabilities, [])

      const requirements: TaskRequirements = {
        provider: 'provider',
      }
      expect(() => selectProviderForTask(requirements, testRegistry)).toThrow(ProviderSelectionError)
    })
  })

  describe('ProviderSelectionError', () => {
    it('should extend Error', () => {
      const error = new ProviderSelectionError('test message')
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe('ProviderSelectionError')
    })

    it('should include cause', () => {
      const cause = new Error('original error')
      const error = new ProviderSelectionError('test message', cause)
      expect(error.cause).toBe(cause)
    })
  })

  describe('selectProvider (global registry)', () => {
    it('should delegate to global registry', () => {
      // This test just ensures the function exists and has correct signature
      expect(typeof selectProvider).toBe('function')
    })
  })

  describe('edge cases', () => {
    it('should handle empty requirements', () => {
      const result = selectProviderForTask({}, registry)
      expect(result.providerId).toBeDefined()
    })

    it('should handle all filters combined', () => {
      const requirements: TaskRequirements = {
        requiredCapabilities: ['streaming'],
        preferredProviders: ['provider-1'],
        maxCostPer1K: 0.02,
        minContextWindow: 100000,
        costOptimized: true,
      }
      const result = selectProviderForTask(requirements, registry)
      expect(result.providerId).toBeDefined()
    })

    it('should handle provider that doesn\'t exist', () => {
      const requirements: TaskRequirements = {
        provider: 'non-existent',
      }
      const result = selectProviderForTask(requirements, registry)
      // Should fall back to best effort
      expect(result.providerId).toBeDefined()
      expect(result.reason).toContain('Best effort selection')
    })
  })
})
