/**
 * Provider Selector
 *
 * Auto-selects providers based on task requirements, capabilities,
 * cost, latency, and health status.
 */

import type { ProviderModel } from '../plugins.js'
import type { ProviderCapabilityRegistry, ProviderQuery, ProviderRegistration } from './registry.js'
import { globalCapabilityRegistry } from './registry.js'

/**
 * Task requirements for provider selection
 */
export interface TaskRequirements {
  /** Required capabilities */
  requiredCapabilities?: readonly string[]
  /** Preferred provider IDs */
  preferredProviders?: readonly string[]
  /** Maximum cost per 1K tokens */
  maxCostPer1K?: number
  /** Minimum context window */
  minContextWindow?: number
  /** Specific model required */
  model?: string
  /** Specific provider required */
  provider?: string
  /** Prefer cheaper options */
  costOptimized?: boolean
  /** Prefer faster options */
  latencyOptimized?: boolean
  /** Allow fallback to less capable providers */
  allowFallback?: boolean
}

/**
 * Selection result
 */
export interface ProviderSelection {
  /** Selected provider ID */
  providerId: string
  /** Selected model ID (if applicable) */
  modelId?: string
  /** Selection reason */
  reason: string
  /** Alternative providers */
  alternatives: string[]
}

/**
 * Select a provider for a task
 */
export function selectProviderForTask(
  requirements: TaskRequirements,
  registry: ProviderCapabilityRegistry = globalCapabilityRegistry,
): ProviderSelection {
  // Build query with only defined values
  const query: ProviderQuery = {}
  if (requirements.requiredCapabilities !== undefined) {
    query.requiredCapabilities = requirements.requiredCapabilities
  }
  if (requirements.preferredProviders !== undefined) {
    query.preferredProviders = requirements.preferredProviders
  }
  if (requirements.maxCostPer1K !== undefined) {
    query.maxCostPer1K = requirements.maxCostPer1K
  }
  if (requirements.minContextWindow !== undefined) {
    query.minContextWindow = requirements.minContextWindow
  }
  if (requirements.model !== undefined) {
    query.model = requirements.model
  }
  if (requirements.provider !== undefined) {
    query.provider = requirements.provider
  }

  // Find matching providers
  let candidates = registry.findProviders(query)

  // No candidates found
  if (candidates.length === 0) {
    return selectBestEffortProvider(requirements, registry)
  }

  // Sort candidates based on preferences
  candidates = sortCandidates(candidates, requirements, registry)

  // Select the best candidate
  const selectedId = candidates[0]
  if (!selectedId) {
    throw new ProviderSelectionError('No candidates available after sorting')
  }

  const registration = registry.getProvider(selectedId)
  if (!registration) {
    throw new ProviderSelectionError(`Provider ${selectedId} not found in registry`)
  }

  // Determine reason
  const reason = determineSelectionReason(selectedId, requirements, registration)

  // Get alternatives
  const alternatives = candidates.slice(1, 4)

  // Select best model if not specified
  let modelId = requirements.model
  if (!modelId && registration.models.length > 0) {
    modelId = selectBestModel(registration.models, requirements)
  }

  const result: ProviderSelection = {
    providerId: selectedId,
    reason,
    alternatives,
  }

  if (modelId !== undefined) {
    result.modelId = modelId
  }

  return result
}

/**
 * Select best effort provider when no exact match is found
 */
function selectBestEffortProvider(
  requirements: TaskRequirements,
  registry: ProviderCapabilityRegistry,
): ProviderSelection {
  const allProviders = registry.getHealthyProviders()

  if (allProviders.length === 0) {
    throw new ProviderSelectionError('No healthy providers available')
  }

  // Sort by general capability score
  const sorted = sortCandidates(allProviders, requirements, registry)
  const selectedId = sorted[0]

  if (!selectedId) {
    throw new ProviderSelectionError('No providers available after sorting')
  }

  const registration = registry.getProvider(selectedId)
  if (!registration) {
    throw new ProviderSelectionError(`Provider ${selectedId} not found in registry`)
  }

  const result: ProviderSelection = {
    providerId: selectedId,
    reason: 'Best effort selection - no exact match found',
    alternatives: sorted.slice(1, 4),
  }

  const firstModel = registration.models[0]
  if (firstModel !== undefined) {
    result.modelId = firstModel.id
  }

  return result
}

/**
 * Sort candidates based on requirements
 */
function sortCandidates(
  candidates: string[],
  requirements: TaskRequirements,
  registry: ProviderCapabilityRegistry,
): string[] {
  return candidates.sort((a, b) => {
    const regA = registry.getProvider(a)
    const regB = registry.getProvider(b)
    if (!regA || !regB) return 0

    // Cost optimization
    if (requirements.costOptimized) {
      const costA = regA.capabilities.pricing?.inputPer1K ?? Number.POSITIVE_INFINITY
      const costB = regB.capabilities.pricing?.inputPer1K ?? Number.POSITIVE_INFINITY
      if (costA !== costB) return costA - costB
    }

    // Latency optimization (use context window as proxy)
    if (requirements.latencyOptimized) {
      const contextA = regA.capabilities.maxContextWindow ?? 0
      const contextB = regB.capabilities.maxContextWindow ?? 0
      // Smaller context = potentially faster
      if (contextA !== contextB) return contextA - contextB
    }

    // Health status (healthy first)
    const healthA = regA.health.healthy ? 1 : 0
    const healthB = regB.health.healthy ? 1 : 0
    if (healthA !== healthB) return healthB - healthA

    // Preference order
    if (requirements.preferredProviders) {
      const prefA = requirements.preferredProviders.indexOf(a)
      const prefB = requirements.preferredProviders.indexOf(b)
      if (prefA !== -1 && prefB !== -1) return prefA - prefB
      if (prefA !== -1) return -1
      if (prefB !== -1) return 1
    }

    // Default: alphabetically
    return a.localeCompare(b)
  })
}

/**
 * Determine the selection reason
 */
function determineSelectionReason(
  providerId: string,
  requirements: TaskRequirements,
  registration: ProviderRegistration,
): string {
  const reasons: string[] = []

  if (requirements.provider === providerId) {
    reasons.push('Explicit provider selection')
  } else if (requirements.model) {
    reasons.push(`Model ${requirements.model} available`)
  } else if (requirements.preferredProviders?.includes(providerId)) {
    reasons.push('Preferred provider')
  }

  if (requirements.requiredCapabilities?.length) {
    reasons.push(`Supports ${requirements.requiredCapabilities.length} required capabilities`)
  }

  if (requirements.costOptimized) {
    const cost = registration.capabilities.pricing?.inputPer1K
    if (cost !== undefined) {
      reasons.push(`Cost-optimized ($${cost}/1K tokens)`)
    }
  }

  return reasons.length > 0 ? reasons.join(', ') : 'Default selection'
}

/**
 * Select the best model from a provider's models
 */
function selectBestModel(models: ProviderModel[], requirements: TaskRequirements): string {
  if (models.length === 0) {
    throw new ProviderSelectionError('No models available for provider')
  }

  // Filter by requirements
  let candidates = [...models]

  if (requirements.minContextWindow) {
    const minCtx = requirements.minContextWindow
    candidates = candidates.filter(
      (m) => m.contextWindow === undefined || m.contextWindow >= minCtx,
    )
  }

  if (candidates.length === 0) {
    candidates = [...models] // Fall back to all models
  }

  // Sort by capability score
  candidates.sort((a, b) => {
    // Prefer models with more capabilities
    const capsA = countCapabilities(a)
    const capsB = countCapabilities(b)
    if (capsA !== capsB) return capsB - capsA

    // Prefer larger context window
    const ctxA = a.contextWindow ?? 0
    const ctxB = b.contextWindow ?? 0
    if (ctxA !== ctxB) return ctxB - ctxA

    // Prefer lower cost
    const costA = a.pricing?.input ?? 0
    const costB = b.pricing?.input ?? 0
    if (costA !== costB) return costA - costB

    // Default: alphabetically
    return a.id.localeCompare(b.id)
  })

  const bestModel = candidates[0]
  if (!bestModel) {
    throw new ProviderSelectionError('No models available after sorting')
  }
  return bestModel.id
}

/**
 * Count capabilities for a model
 */
function countCapabilities(model: ProviderModel): number {
  let count = 0
  if (model.capabilities?.includes('vision')) count++
  if (model.capabilities?.includes('reasoning')) count++
  if (model.capabilities?.includes('tool-calling')) count++
  if (model.capabilities?.includes('structured-output')) count++
  return count
}

/**
 * Selection error
 */
export class ProviderSelectionError extends Error {
  override readonly name: string = 'ProviderSelectionError'
  public override readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.cause = cause
  }
}

/**
 * Convenience function for selecting from global registry
 */
export function selectProvider(requirements: TaskRequirements): ProviderSelection {
  return selectProviderForTask(requirements, globalCapabilityRegistry)
}
