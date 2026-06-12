import { describe, expect, it } from 'vitest'
import { UnknownExecutableProfileError } from '../../src/errors.js'
import {
  type ExecutableProfileDefinition,
  TrustEnforcer,
  resolvePermissions,
} from '../../src/permissions.js'

// Adversarial coverage for the executableProfiles dimension. Profiles are
// operator-defined named executable sets referenced by name from permissions;
// the required guarantees are default-deny on omission, intersection-only
// composition (a profile reference can never widen a ceiling, an explicit
// allowedExecutables can never widen a profile expansion), and a typed
// failure on an unknown profile name before any step runs.

const DEFINITIONS: Readonly<Record<string, ExecutableProfileDefinition>> = {
  linuxReadOnly: { executables: ['ls', 'cat', 'rg'] },
  gitReadOnly: { executables: ['git'] },
}

describe('executableProfiles — default-deny on omission', () => {
  it('denies every executable when neither executableProfiles nor allowedExecutables is set', () => {
    const policy = resolvePermissions(undefined, {}, {}, { executableProfiles: DEFINITIONS })
    const e = new TrustEnforcer(policy)
    expect(e.canExec('ls').allow).toBe(false)
    expect(e.canExec('git').allow).toBe(false)
    expect(policy.executableProfileNames?.size).toBe(0)
  })

  it('an empty executableProfiles list grants nothing', () => {
    const policy = resolvePermissions(
      undefined,
      { executableProfiles: [] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    const e = new TrustEnforcer(policy)
    expect(policy.allowedExecutables.size).toBe(0)
    expect(e.canExec('ls').allow).toBe(false)
  })

  it('a profile reference fails closed when the host supplies no definitions', () => {
    expect(() => resolvePermissions(undefined, { executableProfiles: ['linuxReadOnly'] })).toThrow(
      UnknownExecutableProfileError,
    )
  })
})

describe('executableProfiles — cross-layer intersection (no widening past the ceiling)', () => {
  it('a step-level profile cannot widen beyond the project-default executables', () => {
    const policy = resolvePermissions(
      { allowedExecutables: ['rg'] },
      { executableProfiles: ['linuxReadOnly'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    const e = new TrustEnforcer(policy)
    expect(e.canExec('rg')).toEqual({ allow: true })
    expect(e.canExec('ls').allow).toBe(false)
    expect(e.canExec('cat').allow).toBe(false)
  })

  it('a step-level profile disjoint from the default ceiling yields the empty set', () => {
    const policy = resolvePermissions(
      { allowedExecutables: ['git'] },
      { executableProfiles: ['linuxReadOnly'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    const e = new TrustEnforcer(policy)
    expect(policy.allowedExecutables.size).toBe(0)
    expect(e.canExec('git').allow).toBe(false)
    expect(e.canExec('ls').allow).toBe(false)
  })

  it('a default-layer profile is narrowed by step-level allowedExecutables', () => {
    const policy = resolvePermissions(
      { executableProfiles: ['linuxReadOnly'] },
      { allowedExecutables: ['cat', 'curl'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    const e = new TrustEnforcer(policy)
    expect(e.canExec('cat')).toEqual({ allow: true })
    expect(e.canExec('curl').allow).toBe(false)
    expect(e.canExec('ls').allow).toBe(false)
  })
})

describe('executableProfiles — within-layer intersection (explicit list never widens)', () => {
  it('allowedExecutables alongside a profile narrows the expansion', () => {
    const policy = resolvePermissions(
      undefined,
      { executableProfiles: ['gitReadOnly'], allowedExecutables: ['git', 'curl'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    const e = new TrustEnforcer(policy)
    expect(e.canExec('git')).toEqual({ allow: true })
    expect(e.canExec('curl').allow).toBe(false)
  })

  it('allowedExecutables disjoint from the profile expansion denies everything', () => {
    const policy = resolvePermissions(
      undefined,
      { executableProfiles: ['gitReadOnly'], allowedExecutables: ['curl'] },
      {},
      { executableProfiles: DEFINITIONS },
    )
    expect(policy.allowedExecutables.size).toBe(0)
    expect(new TrustEnforcer(policy).canExec('curl').allow).toBe(false)
  })
})

describe('executableProfiles — unknown names fail closed before the run starts', () => {
  it('throws UnknownExecutableProfileError for a name with no definition', () => {
    expect(() =>
      resolvePermissions(
        undefined,
        { executableProfiles: ['doesNotExist'] },
        {},
        { executableProfiles: DEFINITIONS },
      ),
    ).toThrow(UnknownExecutableProfileError)
  })

  it('reports the offending profile name', () => {
    try {
      resolvePermissions(
        undefined,
        { executableProfiles: ['doesNotExist'] },
        {},
        { executableProfiles: DEFINITIONS },
      )
      expect.unreachable('resolvePermissions should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownExecutableProfileError)
      expect((err as UnknownExecutableProfileError).profileName).toBe('doesNotExist')
      expect((err as Error).message).toMatch(/unknown executable profile: doesNotExist/)
    }
  })

  it('throws even when the unknown name sits in the defaults layer', () => {
    expect(() =>
      resolvePermissions(
        { executableProfiles: ['nope'] },
        undefined,
        {},
        { executableProfiles: DEFINITIONS },
      ),
    ).toThrow(UnknownExecutableProfileError)
  })
})
