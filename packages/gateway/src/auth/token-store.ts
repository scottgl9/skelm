import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { effectiveScopes, isRoleName } from './roles.js'
import { type Scope, isValidScope } from './scopes.js'

const scryptAsync = promisify(scrypt)

const SCRYPT_KEYLEN = 32
const SCRYPT_SALT_BYTES = 16
// 24 bytes → 32-char base64url secret. Plenty of entropy; never persisted.
const SECRET_BYTES = 24

/**
 * Persisted token record. The plaintext secret is NEVER stored — only its
 * scrypt hash with a per-token salt. `secretHash` and `salt` are hex.
 */
export interface StoredToken {
  id: string
  secretHash: string
  salt: string
  roles: string[]
  scopes: Scope[]
  label?: string
  createdAt: string
  expiresAt?: string
  revokedAt?: string
}

/** Public metadata for a token — everything except the hash + salt. */
export interface TokenMetadata {
  id: string
  roles: string[]
  scopes: Scope[]
  label?: string
  createdAt: string
  expiresAt?: string
  revokedAt?: string
}

/** A resolved, currently-valid token: its id and effective scope set. */
export interface ResolvedToken {
  id: string
  scopes: Scope[]
}

export interface CreateTokenInput {
  roles?: string[]
  scopes?: Scope[]
  label?: string
  expiresAt?: string
}

export interface CreatedToken {
  /** Plaintext secret — returned exactly once, never recoverable afterwards. */
  secret: string
  token: TokenMetadata
}

export class TokenValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenValidationError'
  }
}

function toMetadata(t: StoredToken): TokenMetadata {
  return {
    id: t.id,
    roles: t.roles,
    scopes: t.scopes,
    ...(t.label !== undefined && { label: t.label }),
    createdAt: t.createdAt,
    ...(t.expiresAt !== undefined && { expiresAt: t.expiresAt }),
    ...(t.revokedAt !== undefined && { revokedAt: t.revokedAt }),
  }
}

async function hashSecret(secret: string, saltHex: string): Promise<string> {
  const derived = (await scryptAsync(secret, saltHex, SCRYPT_KEYLEN)) as Buffer
  return derived.toString('hex')
}

/**
 * File-backed store of issued scoped tokens. Tokens are hashed with scrypt and
 * a per-token salt; the plaintext secret leaves this module exactly once, at
 * creation. Persisted as JSON at `<stateDir>/tokens.json`, matching the
 * gateway's other state files (dynamic-schedules.json etc.).
 *
 * RBAC is opt-in: when this file is absent or holds no tokens, `size` is 0 and
 * the gateway auth path stays on the legacy single-token behaviour.
 */
export class TokenStore {
  readonly path: string
  private tokens: Map<string, StoredToken> = new Map()
  private loaded = false
  private pendingWrite: Promise<void> = Promise.resolve()

  constructor(stateDir: string) {
    this.path = join(stateDir, 'tokens.json')
  }

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.tokens = new Map()
        this.loaded = true
        return
      }
      throw err
    }
    const parsed = JSON.parse(raw) as unknown
    const map = new Map<string, StoredToken>()
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (isStoredToken(item)) map.set(item.id, item)
      }
    }
    this.tokens = map
    this.loaded = true
  }

  private ensureLoaded(): void {
    if (!this.loaded) throw new Error('TokenStore.load() must be called before use')
  }

  /** Number of issued (including revoked) tokens. Zero ⇒ RBAC inactive. */
  get size(): number {
    this.ensureLoaded()
    return this.tokens.size
  }

  /** True when at least one token has been issued — RBAC is active. */
  get active(): boolean {
    return this.size > 0
  }

  /**
   * Create and persist a token. Validates roles + scopes at this boundary.
   * Returns the plaintext secret once; only the hash is stored.
   */
  async create(input: CreateTokenInput): Promise<CreatedToken> {
    this.ensureLoaded()
    const roles = input.roles ?? []
    const scopes = input.scopes ?? []
    for (const r of roles) {
      if (!isRoleName(r)) throw new TokenValidationError(`unknown role: ${r}`)
    }
    for (const s of scopes) {
      if (!isValidScope(s)) throw new TokenValidationError(`invalid scope: ${s}`)
    }
    if (roles.length === 0 && scopes.length === 0) {
      throw new TokenValidationError('token must grant at least one role or scope')
    }
    if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) {
      throw new TokenValidationError('expiresAt: invalid timestamp')
    }
    if (input.label !== undefined && typeof input.label !== 'string') {
      throw new TokenValidationError('label: must be a string')
    }

    const id = randomUUID()
    const secret = randomBytes(SECRET_BYTES).toString('base64url')
    const salt = randomBytes(SCRYPT_SALT_BYTES).toString('hex')
    const secretHash = await hashSecret(secret, salt)
    const record: StoredToken = {
      id,
      secretHash,
      salt,
      roles,
      scopes,
      ...(input.label !== undefined && { label: input.label }),
      createdAt: new Date().toISOString(),
      ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
    }
    this.tokens.set(id, record)
    await this.persist()
    return { secret, token: toMetadata(record) }
  }

  /** List token metadata. Never includes the hash, salt, or plaintext. */
  list(): TokenMetadata[] {
    this.ensureLoaded()
    return [...this.tokens.values()].map(toMetadata)
  }

  get(id: string): TokenMetadata | undefined {
    this.ensureLoaded()
    const t = this.tokens.get(id)
    return t === undefined ? undefined : toMetadata(t)
  }

  /** Mark a token revoked. Returns false when no such token exists. */
  async revoke(id: string): Promise<boolean> {
    this.ensureLoaded()
    const t = this.tokens.get(id)
    if (t === undefined) return false
    if (t.revokedAt !== undefined) return true
    this.tokens.set(id, { ...t, revokedAt: new Date().toISOString() })
    await this.persist()
    return true
  }

  /**
   * Resolve a presented bearer secret to a valid token. Returns:
   *   - { ok: true, token } when a live, unexpired, unrevoked token matches
   *   - { ok: false, reason } otherwise (unknown / expired / revoked)
   *
   * The hash compare is constant-time. Because the secret carries no id, we
   * iterate candidate tokens; each comparison derives the candidate's hash with
   * that candidate's salt and compares against the stored hash in constant
   * time. The per-token salt means a wrong secret never matches another token.
   */
  async resolve(
    secret: string,
  ): Promise<
    | { ok: true; token: ResolvedToken }
    | { ok: false; reason: 'unknown' | 'expired' | 'revoked'; id?: string }
  > {
    this.ensureLoaded()
    const now = Date.now()
    let matched: StoredToken | undefined
    for (const candidate of this.tokens.values()) {
      const derivedHex = await hashSecret(secret, candidate.salt)
      const a = Buffer.from(derivedHex, 'hex')
      const b = Buffer.from(candidate.secretHash, 'hex')
      if (a.length === b.length && timingSafeEqual(a, b)) {
        matched = candidate
        break
      }
    }
    if (matched === undefined) return { ok: false, reason: 'unknown' }
    if (matched.revokedAt !== undefined) return { ok: false, reason: 'revoked', id: matched.id }
    if (matched.expiresAt !== undefined && Date.parse(matched.expiresAt) <= now) {
      return { ok: false, reason: 'expired', id: matched.id }
    }
    return {
      ok: true,
      token: { id: matched.id, scopes: effectiveScopes(matched.roles, matched.scopes) },
    }
  }

  private persist(): Promise<void> {
    const snapshot = [...this.tokens.values()]
    const prev = this.pendingWrite
    this.pendingWrite = prev.then(
      () => this.writeSnapshot(snapshot),
      () => this.writeSnapshot(snapshot),
    )
    return this.pendingWrite
  }

  private async writeSnapshot(records: StoredToken[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
  }
}

function isStoredToken(value: unknown): value is StoredToken {
  if (value === null || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return (
    typeof t.id === 'string' &&
    typeof t.secretHash === 'string' &&
    typeof t.salt === 'string' &&
    Array.isArray(t.roles) &&
    Array.isArray(t.scopes) &&
    typeof t.createdAt === 'string'
  )
}
