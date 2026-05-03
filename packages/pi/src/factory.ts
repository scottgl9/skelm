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
export function createPiBackendFromConfig(config: PiBackendConfig): ReturnType<typeof createPiBackend> {
  return createPiBackend({
    ...(config.command !== undefined && { command: config.command }),
    ...(config.cwd !== undefined && { cwd: config.cwd }),
    ...(config.args !== undefined && { args: config.args }),
    ...(config.timeout !== undefined && { timeout: config.timeout }),
    ...(config.maxRetries !== undefined && { maxRetries: config.maxRetries }),
    ...(config.logLevel !== undefined && { logLevel: config.logLevel }),
  })
}
