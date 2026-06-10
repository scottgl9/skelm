import { describe, expect, it } from 'vitest'
import { TrustEnforcer, resolvePermissions } from '../../src/permissions.js'

// Adversarial coverage for the exec allowlist (the basename-bypass guard from
// 0366b65). A binary is allowed only by an exact allowlist entry; a
// path-bearing binary must never match a bare-name allowlist entry, or
// ['git'] would accept '/tmp/evil/git'. Required pair: default-deny on
// omission AND explicit-deny on a bypass attempt.
function enforcer(allowedExecutables?: readonly string[]) {
  const policy = resolvePermissions(
    allowedExecutables === undefined ? {} : { allowedExecutables },
    undefined,
  )
  return new TrustEnforcer(policy)
}

describe('TrustEnforcer.canExec — allowlist', () => {
  it('default-deny: denies when allowedExecutables is omitted', () => {
    expect(enforcer().canExec('git').allow).toBe(false)
  })

  it('default-deny: denies safe executables unless allowDefaultSafeExecutables is explicit', () => {
    expect(new TrustEnforcer(resolvePermissions({}, undefined)).canExec('which').allow).toBe(false)
    expect(
      new TrustEnforcer(
        resolvePermissions({ allowDefaultSafeExecutables: true }, undefined),
      ).canExec('which').allow,
    ).toBe(true)
  })

  it('allows a bare name that exactly matches an allowlist entry', () => {
    expect(enforcer(['git']).canExec('git')).toEqual({ allow: true })
  })

  it('allows an absolute path that exactly matches an allowlist entry', () => {
    expect(enforcer(['/usr/bin/git']).canExec('/usr/bin/git')).toEqual({ allow: true })
  })

  it('basename-bypass: denies a path-bearing binary against a bare-name allowlist', () => {
    const d = enforcer(['git']).canExec('/tmp/evil/git')
    expect(d.allow).toBe(false)
    expect(d).toMatchObject({ reason: 'path-not-in-allowlist', dimension: 'executable' })
  })

  it('denies a backslash-path bypass attempt too', () => {
    expect(enforcer(['git']).canExec('C:\\evil\\git').allow).toBe(false)
  })

  it('denies an unknown bare name', () => {
    const d = enforcer(['git']).canExec('curl')
    expect(d.allow).toBe(false)
    expect(d).toMatchObject({ reason: 'not-in-allowlist' })
  })
})
