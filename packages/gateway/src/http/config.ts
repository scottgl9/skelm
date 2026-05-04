/**
 * Auth mode for the server.
 * - `none`: No authentication, only safe when bound to loopback (127.0.0.1)
 * - `bearer`: Bearer token authentication via SKELM_TOKEN env var
 */
export type AuthMode = 'none' | 'bearer'

/**
 * Server configuration
 */
export interface ServerConfig {
  /** Host to bind to. Default: 127.0.0.1 */
  host?: string

  /** Port to bind to. Default: 3000 */
  port?: number

  /** Authentication mode */
  auth: AuthMode

  /** Bearer token for auth mode 'bearer'. If not provided, reads from SKELM_TOKEN env */
  token?: string

  /** Maximum concurrent runs. Default: 10 */
  maxConcurrentRuns?: number
}

/**
 * Validates server config and enforces security invariants
 */
export function validateServerConfig(config: ServerConfig): void {
  if (config.auth === 'none') {
    const host = config.host ?? '127.0.0.1'
    if (host !== '127.0.0.1' && host !== 'localhost') {
      throw new Error(
        'Server auth mode "none" is only allowed when bound to loopback (127.0.0.1 or localhost). ' +
          'Use auth: "bearer" with a token for non-loopback binding.',
      )
    }
  }
}
