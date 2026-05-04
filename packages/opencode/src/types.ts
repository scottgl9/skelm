/**
 * Opencode backend configuration options
 */
export interface OpencodeBackendOptions {
  /** Backend id. Defaults to 'opencode' when only one opencode backend is registered. */
  id?: string

  /** Human-readable label for diagnostics. */
  label?: string

  /** Opencode API key (from OPENCODE_API_KEY env var if not specified) */
  apiKey?: string

  /** Opencode API URL override (for self-hosted instances) */
  apiUrl?: string

  /** Default agent to use (build, plan, or custom agent ID) */
  agent?: string

  /** Permission defaults (can be overridden per pipeline step) */
  permissions?: OpencodePermissionConfig

  /** Path to the opencode binary (defaults to 'opencode' on PATH). */
  command?: string

  /** Model override for this backend */
  model?: string

  /** Temperature for responses */
  temperature?: number

  /** Maximum steps before forcing text response */
  maxSteps?: number

  /** Request timeout in milliseconds */
  timeout?: number

  /** Maximum retry attempts */
  maxRetries?: number

  /** Log level */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'off'
}

/**
 * Permission configuration matching opencode's permission system
 */
export interface OpencodePermissionConfig {
  edit?: 'allow' | 'ask' | 'deny'
  bash?: 'allow' | 'ask' | 'deny'
  read?: 'allow' | 'ask' | 'deny'
  glob?: 'allow' | 'ask' | 'deny'
  grep?: 'allow' | 'ask' | 'deny'
  list?: 'allow' | 'ask' | 'deny'
  task?: 'allow' | 'ask' | 'deny' | Record<string, 'allow' | 'ask' | 'deny'>
  external?: Record<string, 'allow' | 'ask' | 'deny'>
}

/**
 * Mapped permissions for skelm's AgentPermissions
 */
export interface MappedPermissions {
  allowedTools?: string[]
  allowedExecutables?: string[]
  allowedMcpServers?: string[]
  allowedSkills?: string[]
  fsRead?: string[]
  fsWrite?: string[]
}
