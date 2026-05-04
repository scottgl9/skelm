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
  /**
   * Lazy command resolver. When set, the factory awaits this *after* the
   * gateway's coding-agent supervisor has spawned (or registered) the
   * resident pi process, so the backend can target the supervised binary
   * path instead of a static one. Takes precedence over `command` when both
   * are supplied.
   */
  commandProvider?: () => string | Promise<string>
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
    return Promise.resolve(config.commandProvider()).then((cmd) => {
      const merged = { ...config, command: cmd } as PiBackendConfig
      return finalizePi(merged)
    })
  }
  return finalizePi(config)
}

function finalizePi(config: PiBackendConfig): ReturnType<typeof createPiBackend> {
  const result: Record<string, unknown> = {}
  if (config.command !== undefined) result.command = config.command
  if (config.cwd !== undefined) result.cwd = config.cwd
  if (config.args !== undefined) result.args = config.args
  if (config.timeout !== undefined) result.timeout = config.timeout
  if (config.maxRetries !== undefined) result.maxRetries = config.maxRetries
  if (config.logLevel !== undefined) result.logLevel = config.logLevel

  return createPiBackend(result as PiBackendOptions)
}
