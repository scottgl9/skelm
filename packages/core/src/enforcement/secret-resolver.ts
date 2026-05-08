/**
 * Secret resolver interface owned by the gateway.
 *
 * Backends that need a credential ask the gateway for it via this resolver
 * — the secret value never appears in pipeline source. The fact of access
 * is audited; the value is not.
 *
 * Phase 4 ships the env-backed default; Phase 5 adds the file driver and
 * `skelm secrets get|set|list` CLI verbs.
 */
export interface SecretResolver {
  /** Resolve a secret by name. Returns undefined when the secret is unknown. */
  resolve(name: string): Promise<string | undefined>
}

export class MissingSecretError extends Error {
  readonly secretName: string
  constructor(name: string) {
    super(`secret not found: ${name}`)
    this.name = 'MissingSecretError'
    this.secretName = name
  }
}

/**
 * Reads from process.env. Used as the in-process default for unit tests
 * and bare `runPipeline()` invocations.
 *
 * Optionally accepts a custom env map (useful in tests to avoid touching
 * process.env directly).
 */
export class EnvSecretResolver implements SecretResolver {
  private readonly env: Record<string, string | undefined>
  constructor(
    envOrFactory?: Record<string, string | undefined> | (() => Record<string, string | undefined>),
  ) {
    if (typeof envOrFactory === 'function') {
      this.env = envOrFactory()
    } else if (envOrFactory !== undefined) {
      this.env = envOrFactory
    } else {
      this.env = process.env as Record<string, string | undefined>
    }
  }
  async resolve(name: string): Promise<string | undefined> {
    return this.env[name]
  }
}
