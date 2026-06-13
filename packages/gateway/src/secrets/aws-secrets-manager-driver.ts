// AWS Secrets Manager SecretResolver.
//
// Resolves a secret by name via GetSecretValue using the AWS SDK v3 client
// (@aws-sdk/client-secrets-manager). The SDK is used rather than a
// hand-rolled SigV4 signer because request signing is security-sensitive
// and the official client handles the standard credential provider chain
// (env, shared config, SSO, instance/role) for free.
//
// Security: credentials are owned by the SDK client and never logged.
// Resolution errors carry only the secret NAME and the AWS error name —
// never the secret value. The gateway audits the name of each access; the
// value never reaches audit/logs.

import {
  GetSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import type { SecretResolver } from '@skelm/core'

/**
 * Minimal structural view of the SDK client we depend on. Declaring it
 * here lets tests inject a stub `{ send }` without constructing a real
 * client or touching the network.
 */
export interface SecretsManagerSendClient {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>
}

export interface AwsSecretsManagerResolverOptions {
  /** AWS region. When omitted, the SDK resolves it from the environment. */
  readonly region?: string
  /**
   * Explicit credentials. When omitted, the SDK uses the standard provider
   * chain (env vars, shared config, SSO, instance/container role).
   */
  readonly credentials?: {
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly sessionToken?: string
  }
  /** Secret-name prefix applied before every lookup (e.g. `skelm/`). */
  readonly prefix?: string
  /**
   * Optional in-memory TTL cache (milliseconds). The cache holds values in
   * memory only — never persisted or logged.
   */
  readonly cacheTtlMs?: number
  /** Injectable client for tests. Defaults to a real SecretsManagerClient. */
  readonly client?: SecretsManagerSendClient
}

/**
 * Raised on an AWS error other than ResourceNotFound. The message carries
 * the secret name and the AWS error name only — never the secret value.
 */
export class AwsSecretsManagerError extends Error {
  override readonly name = 'AwsSecretsManagerError'
  readonly secretName: string
  constructor(secretName: string, detail: string) {
    super(`aws secrets manager resolution failed for "${secretName}": ${detail}`)
    this.secretName = secretName
  }
}

interface CacheEntry {
  value: string | undefined
  expiresAt: number
}

/**
 * AWS Secrets Manager secret driver. `resolve(name)` calls GetSecretValue
 * and returns the `SecretString`; returns `undefined` when the secret does
 * not exist (ResourceNotFound); throws {@link AwsSecretsManagerError} on any
 * other failure.
 */
export class AwsSecretsManagerResolver implements SecretResolver {
  private readonly client: SecretsManagerSendClient
  private readonly prefix: string
  private readonly cacheTtlMs: number
  private readonly cache = new Map<string, CacheEntry>()

  constructor(options: AwsSecretsManagerResolverOptions = {}) {
    this.prefix = options.prefix ?? ''
    this.cacheTtlMs = options.cacheTtlMs ?? 0
    this.client =
      options.client ??
      new SecretsManagerClient({
        ...(options.region !== undefined && { region: options.region }),
        ...(options.credentials !== undefined && { credentials: options.credentials }),
      })
  }

  async resolve(name: string): Promise<string | undefined> {
    const cached = this.readCache(name)
    if (cached !== null) return cached.value

    const secretId = `${this.prefix}${name}`
    try {
      const out = await this.client.send(new GetSecretValueCommand({ SecretId: secretId }))
      const value = out.SecretString
      this.writeCache(name, value)
      return value
    } catch (err) {
      if (isResourceNotFound(err)) {
        this.writeCache(name, undefined)
        return undefined
      }
      throw new AwsSecretsManagerError(name, sanitizeAwsError(err))
    }
  }

  private readCache(name: string): CacheEntry | null {
    if (this.cacheTtlMs <= 0) return null
    const hit = this.cache.get(name)
    if (hit === undefined) return null
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(name)
      return null
    }
    return hit
  }

  private writeCache(name: string, value: string | undefined): void {
    if (this.cacheTtlMs <= 0) return
    this.cache.set(name, { value, expiresAt: Date.now() + this.cacheTtlMs })
  }
}

function isResourceNotFound(err: unknown): boolean {
  if (err instanceof ResourceNotFoundException) return true
  return err instanceof Error && err.name === 'ResourceNotFoundException'
}

/**
 * Reduce a thrown SDK error to its AWS error name only. The value being
 * resolved is never part of an error from GetSecretValue, but we still
 * avoid echoing arbitrary `.message` text that could contain request
 * context.
 */
function sanitizeAwsError(err: unknown): string {
  if (err instanceof Error && typeof err.name === 'string' && err.name.length > 0) {
    return err.name
  }
  return 'unknown aws error'
}
