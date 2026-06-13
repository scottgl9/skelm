import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TokenStore,
  TokenValidationError,
  effectiveScopes,
  isExemptRoute,
  isRootScopes,
  isValidScope,
  requiredScopeFor,
  scopeSatisfies,
  scopesForRole,
  scopesSatisfy,
} from '../../src/index.js'

describe('scope satisfaction (superset semantics)', () => {
  it('*:* satisfies any concrete scope', () => {
    expect(scopeSatisfies('*:*', 'workflow:edit')).toBe(true)
    expect(scopeSatisfies('*:*', 'secret:rotate')).toBe(true)
  })

  it('resource:* satisfies any action on that resource only', () => {
    expect(scopeSatisfies('workflow:*', 'workflow:edit')).toBe(true)
    expect(scopeSatisfies('workflow:*', 'workflow:read')).toBe(true)
    expect(scopeSatisfies('workflow:*', 'secret:read')).toBe(false)
  })

  it('resource:action satisfies only the exact pair', () => {
    expect(scopeSatisfies('workflow:read', 'workflow:read')).toBe(true)
    expect(scopeSatisfies('workflow:read', 'workflow:edit')).toBe(false)
    expect(scopeSatisfies('workflow:read', 'run:read')).toBe(false)
  })

  it('no implicit action hierarchy: edit does not imply read', () => {
    expect(scopeSatisfies('workflow:edit', 'workflow:read')).toBe(false)
  })

  it('scopesSatisfy checks the whole granted set', () => {
    expect(scopesSatisfy(['run:read', 'workflow:read'], 'workflow:read')).toBe(true)
    expect(scopesSatisfy(['run:read'], 'workflow:read')).toBe(false)
  })

  it('isRootScopes detects *:*', () => {
    expect(isRootScopes(['*:*'])).toBe(true)
    expect(isRootScopes(['workflow:*', 'run:*'])).toBe(false)
  })
})

describe('scope validation', () => {
  it('accepts known resource:action, resource:*, and *:*', () => {
    expect(isValidScope('workflow:read')).toBe(true)
    expect(isValidScope('workflow:*')).toBe(true)
    expect(isValidScope('*:*')).toBe(true)
  })

  it('rejects unknown resources/actions and malformed strings', () => {
    expect(isValidScope('bogus:read')).toBe(false)
    expect(isValidScope('workflow:fly')).toBe(false)
    expect(isValidScope('workflow')).toBe(false)
    expect(isValidScope('a:b:c')).toBe(false)
    expect(isValidScope(':read')).toBe(false)
  })
})

describe('role bundles', () => {
  it('Owner is root', () => {
    expect(scopesForRole('Owner')).toEqual(['*:*'])
  })

  it('Auditor is read + export, nothing mutating', () => {
    const scopes = scopesForRole('Auditor')
    expect(scopesSatisfy(scopes, 'run:read')).toBe(true)
    expect(scopesSatisfy(scopes, 'audit:export')).toBe(true)
    expect(scopesSatisfy(scopes, 'workflow:run')).toBe(false)
    expect(scopesSatisfy(scopes, 'workflow:edit')).toBe(false)
    expect(scopesSatisfy(scopes, 'admin:administer')).toBe(false)
  })

  it('Viewer is read only', () => {
    const scopes = scopesForRole('Viewer')
    expect(scopesSatisfy(scopes, 'workflow:read')).toBe(true)
    expect(scopesSatisfy(scopes, 'workflow:run')).toBe(false)
    expect(scopesSatisfy(scopes, 'audit:export')).toBe(false)
  })

  it('unknown roles contribute nothing', () => {
    expect(scopesForRole('NotARole')).toEqual([])
  })

  it('effectiveScopes is the union of roles and explicit scopes', () => {
    const eff = effectiveScopes(['Viewer'], ['workflow:run'])
    expect(scopesSatisfy(eff, 'workflow:read')).toBe(true)
    expect(scopesSatisfy(eff, 'workflow:run')).toBe(true)
  })
})

describe('route-scope map', () => {
  it('maps reads to <resource>:read and writes to the action', () => {
    expect(requiredScopeFor('GET', '/runs')).toBe('run:read')
    expect(requiredScopeFor('GET', '/runs/abc')).toBe('run:read')
    expect(requiredScopeFor('DELETE', '/runs/abc')).toBe('run:cancel')
    expect(requiredScopeFor('POST', '/runs/abc/approve')).toBe('approval:approve')
    expect(requiredScopeFor('PUT', '/secrets/foo')).toBe('secret:rotate')
    expect(requiredScopeFor('POST', '/v1/workflows/register')).toBe('workflow:publish')
    expect(requiredScopeFor('POST', '/v1/admin/tokens')).toBe('admin:administer')
    expect(requiredScopeFor('POST', '/v1/admin/tokens/abc/revoke')).toBe('admin:administer')
  })

  it('more-specific paths win over their prefixes', () => {
    expect(requiredScopeFor('GET', '/runs/abc/artifacts')).toBe('artifact:read')
    expect(requiredScopeFor('GET', '/runs/abc/artifacts/xyz')).toBe('artifact:read')
    expect(requiredScopeFor('GET', '/runs/abc/events')).toBe('run:read')
  })

  it('unmapped non-exempt routes return undefined (caller denies)', () => {
    expect(requiredScopeFor('POST', '/totally/unknown/route')).toBeUndefined()
  })

  it('health/metrics are exempt', () => {
    expect(isExemptRoute('GET', '/health')).toBe(true)
    expect(isExemptRoute('GET', '/healthz')).toBe(true)
    expect(isExemptRoute('GET', '/readyz')).toBe(true)
    expect(isExemptRoute('GET', '/metrics')).toBe(true)
    expect(isExemptRoute('GET', '/runs')).toBe(false)
  })
})

describe('TokenStore — hashing + persistence', () => {
  let stateDir: string

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'skelm-token-store-'))
  })

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })

  it('is inactive until a token is issued', async () => {
    const store = new TokenStore(stateDir)
    await store.load()
    expect(store.active).toBe(false)
    expect(store.size).toBe(0)
  })

  it('never persists the plaintext secret', async () => {
    const store = new TokenStore(stateDir)
    await store.load()
    const { secret, token } = await store.create({ roles: ['Viewer'] })
    expect(secret).toBeTruthy()
    const onDisk = await readFile(store.path, 'utf8')
    expect(onDisk).not.toContain(secret)
    // Metadata listing never returns hash/salt/secret.
    const listed = store.list()
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(secret)
    expect(listed[0]).not.toHaveProperty('secretHash')
    expect(listed[0]).not.toHaveProperty('salt')
    expect(listed[0]?.id).toBe(token.id)
  })

  it('resolves a valid secret to its effective scopes', async () => {
    const store = new TokenStore(stateDir)
    await store.load()
    const { secret } = await store.create({ roles: ['Viewer'], scopes: ['workflow:run'] })
    const res = await store.resolve(secret)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(scopesSatisfy(res.token.scopes, 'workflow:read')).toBe(true)
      expect(scopesSatisfy(res.token.scopes, 'workflow:run')).toBe(true)
    }
  })

  it('rejects unknown, expired, and revoked secrets', async () => {
    const store = new TokenStore(stateDir)
    await store.load()
    expect((await store.resolve('nope')).ok).toBe(false)

    const expired = await store.create({
      roles: ['Viewer'],
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    const er = await store.resolve(expired.secret)
    expect(er.ok).toBe(false)
    if (!er.ok) expect(er.reason).toBe('expired')

    const live = await store.create({ roles: ['Viewer'] })
    await store.revoke(live.token.id)
    const rr = await store.resolve(live.secret)
    expect(rr.ok).toBe(false)
    if (!rr.ok) expect(rr.reason).toBe('revoked')
  })

  it('rejects invalid roles/scopes at creation', async () => {
    const store = new TokenStore(stateDir)
    await store.load()
    await expect(store.create({ roles: ['Nope'] })).rejects.toBeInstanceOf(TokenValidationError)
    await expect(store.create({ scopes: ['bad:bad'] })).rejects.toBeInstanceOf(TokenValidationError)
    await expect(store.create({})).rejects.toBeInstanceOf(TokenValidationError)
  })

  it('survives a reload from disk', async () => {
    const store = new TokenStore(stateDir)
    await store.load()
    const { secret } = await store.create({ roles: ['Owner'] })
    const reopened = new TokenStore(stateDir)
    await reopened.load()
    expect(reopened.active).toBe(true)
    const res = await reopened.resolve(secret)
    expect(res.ok).toBe(true)
    if (res.ok) expect(isRootScopes(res.token.scopes)).toBe(true)
  })
})
