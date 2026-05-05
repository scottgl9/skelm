/**
 * Provider Capability Registry
 *
 * Tracks provider capabilities, models, and health status.
 * Enables auto-selection of providers based on task requirements.
 */

import type { PluginHealthStatus, ProviderModel } from '../plugins.js'
import type { ProviderCapabilities, ProviderSpecificCapabilities } from './base.js'

/**
 * Query for finding providers by capability
 */
export interface ProviderQuery {
  /** Required capabilities (all must be present) */
  requiredCapabilities?: readonly string[]
  /** Preferred provider IDs (in order of preference) */
  preferredProviders?: readonly string[]
  /** Maximum cost per 1K tokens */
  maxCostPer1K?: number
  /** Minimum context window size */
  minContextWindow?: number
  /** Require specific model */
  model?: string
  /** Require specific provider */
  provider?: string
}

/**
 * Provider registration info
 */
export interface ProviderRegistration {
  /** Provider ID */
  id: string
  /** Human-readable name */
  name: string
  /** Provider capabilities */
  capabilities: ProviderCapabilities
  /** Available models */
  models: ProviderModel[]
  /** Health status */
  health: PluginHealthStatus
  /** Registration timestamp */
  registeredAt: string
  /** Last health check */
  lastHealthCheck?: string
}

/**
 * Capability registry for providers
 */
export class ProviderCapabilityRegistry {
  private readonly providers = new Map<string, ProviderRegistration>()
  private readonly capabilityIndex = new Map<string, Set<string>>()
  private readonly modelIndex = new Map<string, string>() // modelId -> providerId

  /**
   * Register a provider
   */
  registerProvider(
    providerId: string,
    name: string,
    capabilities: ProviderCapabilities,
    models: ProviderModel[],
  ): void {
    const registration: ProviderRegistration = {
      id: providerId,
      name,
      capabilities,
      models,
      health: {
        healthy: true,
        status: 'registered',
        lastCheck: new Date().toISOString(),
      },
      registeredAt: new Date().toISOString(),
    }

    this.providers.set(providerId, registration)

    // Index by capabilities
    this.indexCapabilities(providerId, capabilities)

    // Index by models
    for (const model of models) {
      this.modelIndex.set(model.id, providerId)
    }

    console.info(`Provider registered: ${providerId} (${name})`)
  }

  /**
   * Unregister a provider
   */
  unregisterProvider(providerId: string): void {
    const registration = this.providers.get(providerId)
    if (!registration) return

    // Remove from capability index
    this.removeFromCapabilityIndex(providerId)

    // Remove from model index
    for (const [modelId, pid] of this.modelIndex.entries()) {
      if (pid === providerId) {
        this.modelIndex.delete(modelId)
      }
    }

    this.providers.delete(providerId)
    console.info(`Provider unregistered: ${providerId}`)
  }

  /**
   * Get a provider by ID
   */
  getProvider(providerId: string): ProviderRegistration | undefined {
    return this.providers.get(providerId)
  }

  /**
   * Get all registered providers
   */
  listProviders(): readonly ProviderRegistration[] {
    return [...this.providers.values()]
  }

  /**
   * Find providers that support a specific capability
   */
  findProvidersForCapability(capability: string): string[] {
    const providerIds = this.capabilityIndex.get(capability)
    return providerIds ? [...providerIds] : []
  }

  /**
   * Find providers matching a query
   */
  findProviders(query: ProviderQuery): string[] {
    let candidates = [...this.providers.values()]

    // Filter by required capabilities
    if (query.requiredCapabilities && query.requiredCapabilities.length > 0) {
      candidates = candidates.filter((p) =>
        query.requiredCapabilities?.every((cap) => this.hasCapability(p.capabilities, cap)),
      )
    }

    // Filter by provider preference
    if (query.preferredProviders && query.preferredProviders.length > 0) {
      candidates = candidates.filter((p) => query.preferredProviders?.includes(p.id))
    }

    // Filter by max cost
    if (query.maxCostPer1K !== undefined) {
      const maxCost = query.maxCostPer1K
      candidates = candidates.filter(
        (p) =>
          p.capabilities.pricing?.inputPer1K === undefined ||
          p.capabilities.pricing.inputPer1K <= maxCost,
      )
    }

    // Filter by min context window
    if (query.minContextWindow !== undefined) {
      const minCtx = query.minContextWindow
      candidates = candidates.filter(
        (p) =>
          p.capabilities.maxContextWindow === undefined ||
          p.capabilities.maxContextWindow >= minCtx,
      )
    }

    // Filter by specific model
    if (query.model) {
      candidates = candidates.filter((p) => p.models.some((m) => m.id === query.model))
    }

    // Filter by specific provider
    if (query.provider) {
      candidates = candidates.filter((p) => p.id === query.provider)
    }

    // Sort by health status and preference
    return candidates.filter((p) => p.health.healthy).map((p) => p.id)
  }

  /**
   * Get models for a provider
   */
  getModels(providerId: string): ProviderModel[] {
    const registration = this.providers.get(providerId)
    return registration?.models ?? []
  }

  /**
   * Get provider for a specific model
   */
  getProviderForModel(modelId: string): string | undefined {
    return this.modelIndex.get(modelId)
  }

  /**
   * Update health status for a provider
   */
  updateHealth(providerId: string, health: PluginHealthStatus): void {
    const registration = this.providers.get(providerId)
    if (!registration) return

    registration.health = {
      ...health,
      lastCheck: new Date().toISOString(),
    }
  }

  /**
   * Check health for a specific provider
   */
  async checkProviderHealth(
    providerId: string,
    healthCheckFn: () => Promise<PluginHealthStatus>,
  ): Promise<PluginHealthStatus> {
    try {
      const health = await healthCheckFn()
      this.updateHealth(providerId, health)
      return health
    } catch (error) {
      const health: PluginHealthStatus = {
        healthy: false,
        status: 'error',
        lastCheck: new Date().toISOString(),
        errors: [error instanceof Error ? error.message : String(error)],
      }
      this.updateHealth(providerId, health)
      return health
    }
  }

  /**
   * Check health for all providers
   */
  async checkAllProvidersHealth(
    healthChecks: Map<string, () => Promise<PluginHealthStatus>>,
  ): Promise<Record<string, PluginHealthStatus>> {
    const results: Record<string, PluginHealthStatus> = {}

    for (const [providerId, checkFn] of healthChecks) {
      try {
        results[providerId] = await this.checkProviderHealth(providerId, checkFn)
      } catch (error) {
        results[providerId] = {
          healthy: false,
          status: 'error',
          lastCheck: new Date().toISOString(),
          errors: [error instanceof Error ? error.message : String(error)],
        }
      }
    }

    return results
  }

  /**
   * Get healthy providers
   */
  getHealthyProviders(): string[] {
    return [...this.providers.values()].filter((p) => p.health.healthy).map((p) => p.id)
  }

  /**
   * Clear all providers
   */
  clear(): void {
    this.providers.clear()
    this.capabilityIndex.clear()
    this.modelIndex.clear()
  }

  /**
   * Index capabilities for a provider
   */
  private indexCapabilities(providerId: string, capabilities: ProviderCapabilities): void {
    // Base capabilities from BackendCapabilities
    const baseCaps: readonly (keyof ProviderCapabilities)[] = [
      'prompt',
      'streaming',
      'sessionLifecycle',
      'mcp',
      'skills',
      'modelSelection',
      'toolPermissions',
    ]

    for (const cap of baseCaps) {
      const value = capabilities[cap]
      if (value !== undefined && value !== false) {
        this.addCapabilityIndex(cap.toString(), providerId)
      }
    }

    // Provider-specific capabilities
    if (capabilities.providerSpecific) {
      const providerCaps: readonly (keyof ProviderSpecificCapabilities)[] = [
        'structuredOutput',
        'vision',
        'reasoning',
        'toolCalling',
        'functionCalling',
        'systemPrompts',
        'multiTurn',
        'streaming',
        'contextCaching',
        'parallelToolCalls',
      ]

      for (const cap of providerCaps) {
        const value = capabilities.providerSpecific[cap]
        if (value === true) {
          this.addCapabilityIndex(`providerSpecific.${cap}`, providerId)
        }
      }
    }
  }

  private addCapabilityIndex(capability: string, providerId: string): void {
    let providerIds = this.capabilityIndex.get(capability)
    if (!providerIds) {
      providerIds = new Set()
      this.capabilityIndex.set(capability, providerIds)
    }
    providerIds.add(providerId)
  }

  private removeFromCapabilityIndex(providerId: string): void {
    for (const providerIds of this.capabilityIndex.values()) {
      providerIds.delete(providerId)
    }
  }

  private hasCapability(capabilities: ProviderCapabilities, capability: string): boolean {
    // Check base capabilities
    if (capability in capabilities) {
      const value = capabilities[capability as keyof ProviderCapabilities]
      return value !== undefined && value !== false
    }

    // Check provider-specific capabilities
    if (capability.startsWith('providerSpecific.')) {
      const specificCap = capability.slice('providerSpecific.'.length)
      if (capabilities.providerSpecific && specificCap in capabilities.providerSpecific) {
        return (
          capabilities.providerSpecific[specificCap as keyof ProviderSpecificCapabilities] === true
        )
      }
    }

    return false
  }
}

/**
 * Global capability registry instance
 */
export const globalCapabilityRegistry = new ProviderCapabilityRegistry()
