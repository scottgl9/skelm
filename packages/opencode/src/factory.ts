/**
 * Factory function for creating opencode backend from CLI config
 * This mirrors the pattern used in packages/cli/src/backends.ts
 */

import { createOpencodeBackend } from './backend.js'
import type { OpencodeBackendOptions } from './types.js'

/**
 * Configuration for opencode backend in skelm.config.ts
 */
export interface OpencodeBackendConfig {
  /** Opencode API key (or { secret: 'ENV_VAR_NAME' } for env lookup) */
  apiKey?: string | { secret: string }
  /** Opencode API URL (optional, defaults to opencode.ai) */
  apiUrl?: string
  /** Default agent to use (defaults to 'build') */
  agent?: string
  /** Request timeout in ms */
  timeout?: number
  /** Maximum retries on failure */
  maxRetries?: number
  /** Log level */
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

/**
 * Create an opencode backend from CLI configuration
 */
export function createOpencodeBackendFromConfig(
  config: OpencodeBackendConfig
): ReturnType<typeof createOpencodeBackend> {
  const directApiKey = typeof config.apiKey === 'string' ? config.apiKey : undefined
  const secretApiKey =
    typeof config.apiKey === 'object' && config.apiKey !== null && 'secret' in config.apiKey
      ? process.env[config.apiKey.secret as string]
      : undefined

  const resolvedApiKey = directApiKey ?? secretApiKey

  if (!resolvedApiKey) {
    throw new Error(
      'Opencode API key not configured. Set opencode.apiKey in config or OPENCODE_API_KEY env var.'
    )
  }

  return createOpencodeBackend({
    apiKey: resolvedApiKey,
    ...(config.apiUrl !== undefined && { apiUrl: config.apiUrl }),
    ...(config.agent !== undefined && { agent: config.agent }),
    ...(config.timeout !== undefined && { timeout: config.timeout }),
    ...(config.maxRetries !== undefined && { maxRetries: config.maxRetries }),
    ...(config.logLevel !== undefined && { logLevel: config.logLevel }),
  })
}
