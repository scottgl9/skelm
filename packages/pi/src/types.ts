/**
 * Types for @skelm/pi - Pi coding agent backend
 */

export interface PiBackendOptions {
  /** Pi agent command (defaults to 'pi') */
  command?: string
  /** Working directory for the pi process */
  cwd?: string
  /** Additional arguments to pass to pi */
  args?: readonly string[]
  /** Request timeout in ms */
  timeout?: number
  /** Maximum retries on failure */
  maxRetries?: number
  /** Log level */
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

export interface PiPermissionConfig {
  /** Allow bash command execution */
  allowBash: boolean
  /** Allow file read operations */
  allowFsRead: boolean
  /** Allow file write operations */
  allowFsWrite: boolean
  /** Allowed executable patterns */
  allowedExecutables: readonly string[]
  /** Allowed MCP servers */
  allowedMcpServers: readonly string[]
}

export interface MappedPermissions {
  /** Commands that are allowed */
  allowed: readonly string[]
  /** Commands that are denied */
  denied: readonly string[]
}
