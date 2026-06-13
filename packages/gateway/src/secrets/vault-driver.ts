// Vault SecretResolver — HashiCorp Vault KV v2 driver.
//
// Resolves a secret by name against a Vault KV v2 mount over HTTP. The
// constructor signature is fixed by the original seam so call sites that
// were written against `new VaultSecretResolver({ url, token, mount })`
// keep working unchanged.
//
// Security: the auth token is held privately and is never logged, thrown,
// or serialized. Resolution errors carry only the secret NAME and the
// transport status — never the secret value or the token. The gateway
// audits the name of each access; the value never reaches audit/logs.

import type { SecretResolver } from '@skelm/core'

export interface VaultSecretResolverOptions {
  /** Vault server URL, e.g. https://vault.internal:8200 */
  readonly url: string
  /** Auth token. Production wires this from a short-lived credential. */
  readonly token: string
  /**
   * KV v2 mount path; defaults to `secret`. Reserved on the seam so
   * deployments with custom mounts don't have to migrate later.
   */
  readonly mount?: string
  /**
   * Secret-name prefix applied before every lookup (e.g. `skelm/`).
   * Useful for namespacing per environment.
   */
  readonly prefix?: string
  /**
   * Which key inside the KV v2 secret's `data` map to return. Defaults to
   * `value`, matching the convention `vault kv put secret/NAME value=...`.
   */
  readonly field?: string
  /**
   * Optional in-memory TTL cache (milliseconds). When set, a resolved
   * value is cached for this long to avoid a round-trip per access. The
   * cache holds values in memory only — never persisted or logged.
   */
  readonly cacheTtlMs?: number
  /** Injectable fetch for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch
}

/**
 * Reserved for callers that wrote against the pre-implementation seam.
 * No longer thrown by the driver; kept exported so existing imports and
 * the public baseline stay stable.
 */
export class VaultNotImplementedError extends Error {
  override readonly name = 'VaultNotImplementedError'
  constructor() {
    super('VaultSecretResolver is implemented — this error is no longer thrown')
  }
}

/**
 * Raised when Vault returns an auth/transport failure (anything other than
 * a hit or a 404). The message carries the secret name and HTTP status
 * only — never the secret value or the Vault token.
 */
export class VaultSecretError extends Error {
  override readonly name = 'VaultSecretError'
  readonly secretName: string
  readonly status?: number
  constructor(secretName: string, detail: string, status?: number) {
    const statusSuffix = status !== undefined ? ` (status ${status})` : ''
    super(`vault secret resolution failed for "${secretName}"${statusSuffix}: ${detail}`)
    this.secretName = secretName
    if (status !== undefined) this.status = status
  }
}

interface CacheEntry {
  value: string | undefined
  expiresAt: number
}

/**
 * HashiCorp Vault KV v2 secret driver. `resolve(name)` issues a GET against
 * `<url>/v1/<mount>/data/<prefix><name>` and returns the `field` entry from
 * the KV v2 payload. Returns `undefined` on 404 (unknown secret); throws
 * {@link VaultSecretError} on auth/transport failure.
 */
export class VaultSecretResolver implements SecretResolver {
  private readonly token: string
  private readonly url: string
  private readonly mount: string
  private readonly prefix: string
  private readonly field: string
  private readonly cacheTtlMs: number
  private readonly doFetch: typeof fetch
  private readonly cache = new Map<string, CacheEntry>()

  constructor(readonly options: VaultSecretResolverOptions) {
    this.token = options.token
    this.url = options.url.replace(/\/+$/, '')
    this.mount = (options.mount ?? 'secret').replace(/^\/+|\/+$/g, '')
    this.prefix = options.prefix ?? ''
    this.field = options.field ?? 'value'
    this.cacheTtlMs = options.cacheTtlMs ?? 0
    this.doFetch = options.fetch ?? globalThis.fetch
  }

  async resolve(name: string): Promise<string | undefined> {
    const cached = this.readCache(name)
    if (cached !== null) return cached.value

    const path = buildSecretPath(this.prefix, name)
    const requestUrl = `${this.url}/v1/${this.mount}/data/${path}`

    let res: Response
    try {
      res = await this.doFetch(requestUrl, {
        method: 'GET',
        headers: { 'X-Vault-Token': this.token },
      })
    } catch (err) {
      // Never surface the token; report only the transport class.
      throw new VaultSecretError(name, sanitizeTransport(err))
    }

    if (res.status === 404) {
      this.writeCache(name, undefined)
      return undefined
    }
    if (!res.ok) {
      throw new VaultSecretError(name, 'vault returned a non-OK status', res.status)
    }

    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new VaultSecretError(name, 'vault response was not valid JSON', res.status)
    }

    const value = extractKvV2Field(body, this.field)
    if (value === undefined) {
      throw new VaultSecretError(
        name,
        `vault response did not contain field "${this.field}"`,
        res.status,
      )
    }
    this.writeCache(name, value)
    return value
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

function buildSecretPath(prefix: string, name: string): string {
  const combined = `${prefix}${name}`
  const segments = combined.split('/')
  if (segments.includes('.') || segments.includes('..')) {
    throw new VaultSecretError(name, 'vault secret path must not contain dot segments')
  }
  return segments.map(encodeURIComponent).join('/')
}

/** Read `.data.data[field]` from a KV v2 GET payload. */
function extractKvV2Field(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const data = (body as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return undefined
  const inner = (data as { data?: unknown }).data
  if (typeof inner !== 'object' || inner === null) return undefined
  const v = (inner as Record<string, unknown>)[field]
  return typeof v === 'string' ? v : undefined
}

/**
 * Reduce a thrown fetch error to a non-sensitive class. The token lives in
 * the request header, not the error, but we still avoid echoing arbitrary
 * error text that a custom fetch stub might have populated with the URL.
 */
function sanitizeTransport(err: unknown): string {
  if (err instanceof Error && typeof err.name === 'string' && err.name.length > 0) {
    return `transport error (${err.name})`
  }
  return 'transport error'
}
