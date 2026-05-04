/**
 * Factory function for creating pi backend from CLI config
 */

import { createPiBackend } from './backend.js'
import type { PiBackendOptions } from './types.js'

/**
 * Configuration for pi backend in skelm.config.ts
 */
export interface PiBackendConfig {
  /** Pi command (defaults to 'pi') */
  command?: string
  /** Working directory */
  cwd?: string
  /** Additional arguments */
  args?: readonly string[]
  /** Request timeout in ms */
  timeout?: number
  /** Maximum retries on failure */
  maxRetries?: number
  /** Log level */
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

/**
 * Create a pi backend from CLI configuration
 */
export function createPiBackendFromConfig(
  config: PiBackendConfig,
): ReturnType<typeof createPiBackend> {
  const result: Record<string, unknown> = {}
  if (config.command !== undefined) result.command = config.command
  if (config.cwd !== undefined) result.cwd = config.cwd
  if (config.args !== undefined) result.args = config.args
  if (config.timeout !== undefined) result.timeout = config.timeout
  if (config.maxRetries !== undefined) result.maxRetries = config.maxRetries
  if (config.logLevel !== undefined) result.logLevel = config.logLevel

  return createPiBackend(result as PiBackendOptions)
}
