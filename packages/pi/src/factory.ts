/**
 * Factory function for creating pi backend from CLI config
 */

import { createPiBackend } from './backend.js'
import type { PiBackendOptions } from './types.js'

/**
 * Configuration for pi backend in skelm.config.ts
 */
export interface PiBackendConfig {
  /** Backend id */
  id?: string
  /** Human-readable label */
  label?: string
  /** Path to the pi binary (default: 'pi') */
  command?: string
  /**
   * Lazy command resolver — awaited after gateway startup, overrides command.
   */
  commandProvider?: () => string | Promise<string>
  /** Provider name (e.g. 'llamacpp', 'anthropic') */
  provider?: string
  /** Model ID (e.g. 'qwen36') */
  model?: string
  /** Working directory */
  cwd?: string
  /** Request timeout in ms */
  timeout?: number
  /** Max concurrent pi processes */
  maxConcurrent?: number
}

/**
 * Create a pi backend from CLI configuration.
 * Synchronous when commandProvider is omitted; returns a Promise otherwise.
 */
export async function createPiBackendFromConfig(
  config: PiBackendConfig,
): Promise<ReturnType<typeof createPiBackend>>
export function createPiBackendFromConfig(
  config: PiBackendConfig & { commandProvider?: undefined },
): ReturnType<typeof createPiBackend>
export function createPiBackendFromConfig(
  config: PiBackendConfig,
): ReturnType<typeof createPiBackend> | Promise<ReturnType<typeof createPiBackend>> {
  if (config.commandProvider !== undefined) {
    return Promise.resolve(config.commandProvider()).then((cmd) =>
      createPiBackend({ ...config, command: cmd }),
    )
  }
  return createPiBackend(config)
}
