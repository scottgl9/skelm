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
 */
export class EnvSecretResolver implements SecretResolver {
  async resolve(name: string): Promise<string | undefined> {
    return process.env[name]
  }
}
