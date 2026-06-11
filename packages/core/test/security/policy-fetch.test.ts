// Tests for createPolicyFetch — the network-policy-enforcing fetch wrapper.
//
// The wrapper is wired into BackendContext.fetch in the runner, so backends
// using ctx.fetch instead of globalThis.fetch get network egress enforcement
// for free. This file pins the wrapper's behaviour (allow, deny, event emit).

import { describe, expect, it, vi } from 'vitest'
import { PermissionDeniedError } from '../../src/errors.js'
import { TrustEnforcer, createPolicyFetch, resolvePermissions } from '../../src/permissions.js'

describe('createPolicyFetch', () => {
  it('allows requests to hosts in the allowlist', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions({ networkEgress: { allowHosts: ['api.example.com'] } }, undefined),
    )
    const base = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }),
    )
    const pf = createPolicyFetch(enforcer, undefined, base as unknown as typeof fetch)
    const res = await pf('https://api.example.com/v1/data')
    expect(res.status).toBe(200)
    expect(base).toHaveBeenCalledOnce()
  })

  it('denies requests to hosts not in the allowlist', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions({ networkEgress: { allowHosts: ['api.example.com'] } }, undefined),
    )
    const base = vi.fn()
    const pf = createPolicyFetch(enforcer, undefined, base as unknown as typeof fetch)
    await expect(pf('https://evil.example.com/steal')).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(base).not.toHaveBeenCalled()
  })

  it('denies all requests when networkEgress is "deny"', async () => {
    const enforcer = new TrustEnforcer(resolvePermissions({ networkEgress: 'deny' }, undefined))
    const base = vi.fn()
    const pf = createPolicyFetch(enforcer, undefined, base as unknown as typeof fetch)
    await expect(pf('https://anywhere.example.com/')).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(base).not.toHaveBeenCalled()
  })

  it('allows all requests when networkEgress is "allow"', async () => {
    const enforcer = new TrustEnforcer(resolvePermissions({ networkEgress: 'allow' }, undefined))
    const base = vi.fn(async () => new Response('ok', { status: 200 }))
    const pf = createPolicyFetch(enforcer, undefined, base as unknown as typeof fetch)
    await pf('https://anywhere.example.com/')
    expect(base).toHaveBeenCalledOnce()
  })

  it('emits a permission.denied event on denial when events are supplied', async () => {
    const enforcer = new TrustEnforcer(resolvePermissions({ networkEgress: 'deny' }, undefined))
    const published: unknown[] = []
    const events = {
      publish: (ev: unknown) => {
        published.push(ev)
      },
      runId: 'r1',
      stepId: 's1',
    }
    const base = vi.fn()
    const pf = createPolicyFetch(enforcer, events as never, base as unknown as typeof fetch)
    await expect(pf('https://example.com/')).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(published).toHaveLength(1)
    const ev = published[0] as { type: string; dimension: string; runId: string; stepId: string }
    expect(ev.type).toBe('permission.denied')
    expect(ev.dimension).toBe('network')
    expect(ev.runId).toBe('r1')
    expect(ev.stepId).toBe('s1')
  })

  it('denies requests with an unparseable URL', async () => {
    const enforcer = new TrustEnforcer(resolvePermissions({ networkEgress: 'allow' }, undefined))
    const base = vi.fn()
    const pf = createPolicyFetch(enforcer, undefined, base as unknown as typeof fetch)
    await expect(pf('not-a-url')).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(base).not.toHaveBeenCalled()
  })

  it('blocks a cloud-metadata IP even under an "allow" policy', async () => {
    const enforcer = new TrustEnforcer(resolvePermissions({ networkEgress: 'allow' }, undefined))
    const base = vi.fn()
    const pf = createPolicyFetch(enforcer, undefined, base as unknown as typeof fetch)
    await expect(pf('http://169.254.169.254/latest/meta-data/iam/')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    )
    expect(base).not.toHaveBeenCalled()
  })

  it('blocks a hostname that resolves to cloud metadata', async () => {
    const enforcer = new TrustEnforcer(resolvePermissions({ networkEgress: 'allow' }, undefined))
    const base = vi.fn()
    const pf = createPolicyFetch(enforcer, undefined, base as unknown as typeof fetch, {
      lookup: async () => [{ address: '169.254.169.254' }],
    })
    await expect(pf('http://metadata.internal/latest')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    )
    expect(base).not.toHaveBeenCalled()
  })

  it('blocks a cloud-metadata IP even when it is in the allowlist', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions({ networkEgress: { allowHosts: ['169.254.169.254'] } }, undefined),
    )
    const base = vi.fn()
    const pf = createPolicyFetch(enforcer, undefined, base as unknown as typeof fetch)
    await expect(pf('http://169.254.169.254/')).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(base).not.toHaveBeenCalled()
  })

  it('still allows a metadata IP under an operator unrestricted bypass', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions({ requestUnrestricted: true }, undefined, {}, { grantUnrestricted: true }),
    )
    const base = vi.fn(async () => new Response('ok', { status: 200 }))
    const pf = createPolicyFetch(enforcer, undefined, base as unknown as typeof fetch)
    await pf('http://169.254.169.254/')
    expect(base).toHaveBeenCalledOnce()
  })

  it('accepts URL objects in addition to strings', async () => {
    const enforcer = new TrustEnforcer(
      resolvePermissions({ networkEgress: { allowHosts: ['api.example.com'] } }, undefined),
    )
    const base = vi.fn(async () => new Response('ok', { status: 200 }))
    const pf = createPolicyFetch(enforcer, undefined, base as unknown as typeof fetch)
    await pf(new URL('https://api.example.com/path'))
    expect(base).toHaveBeenCalledOnce()
  })
})
