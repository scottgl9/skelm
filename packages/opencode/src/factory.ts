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
  /**
   * Lazy URL resolver. When set, the factory awaits this *after* the
   * gateway's coding-agent supervisor has spawned the resident
   * `opencode serve` process, so the backend targets the supervised URL
   * instead of a static one. Takes precedence over apiUrl when both are
   * supplied.
   */
  apiUrlProvider?: () => string | Promise<string>
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
export async function createOpencodeBackendFromConfig(
  config: OpencodeBackendConfig,
): Promise<ReturnType<typeof createOpencodeBackend>>
export function createOpencodeBackendFromConfig(
  config: OpencodeBackendConfig & { apiUrlProvider?: undefined },
): ReturnType<typeof createOpencodeBackend>
export function createOpencodeBackendFromConfig(
  config: OpencodeBackendConfig,
): ReturnType<typeof createOpencodeBackend> | Promise<ReturnType<typeof createOpencodeBackend>> {
  const directApiKey = typeof config.apiKey === 'string' ? config.apiKey : undefined
  const secretApiKey =
    typeof config.apiKey === 'object' && config.apiKey !== null && 'secret' in config.apiKey
      ? process.env[config.apiKey.secret as string]
      : undefined

  const resolvedApiKey = directApiKey ?? secretApiKey

  if (!resolvedApiKey) {
    throw new Error(
      'Opencode API key not configured. Set opencode.apiKey in config or OPENCODE_API_KEY env var.',
    )
  }

  const result: Record<string, unknown> = { apiKey: resolvedApiKey }
  // apiUrlProvider (the gateway-supervised URL) takes precedence over a static apiUrl.
  if (config.apiUrlProvider !== undefined) {
    const promise = Promise.resolve(config.apiUrlProvider()).then((apiUrl) => {
      if (apiUrl !== undefined) result.apiUrl = apiUrl
      return finalizeOpencode(result, config)
    })
    return promise
  }
  if (config.apiUrl !== undefined) result.apiUrl = config.apiUrl
  return finalizeOpencode(result, config)
}

function finalizeOpencode(
  result: Record<string, unknown>,
  config: OpencodeBackendConfig,
): ReturnType<typeof createOpencodeBackend> {
  if (config.agent !== undefined) result.agent = config.agent
  if (config.timeout !== undefined) result.timeout = config.timeout
  if (config.maxRetries !== undefined) result.maxRetries = config.maxRetries
  if (config.logLevel !== undefined) result.logLevel = config.logLevel

  return createOpencodeBackend(result as OpencodeBackendOptions)
}
