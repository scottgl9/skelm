import { describe, expect, it } from 'vitest'
import { TrustEnforcer, createPolicyFetch, resolvePermissions } from '../../src/permissions.js'

// Adversarial coverage for the full-permission-bypass (`requestUnrestricted`)
// dimension. The bypass is TWO-KEYED: an author may *request* it, but it only
// takes effect when the operator (gateway) passes `{ grantUnrestricted: true }`.
// A pipeline can never self-escalate. These tests pin every corner of that
// truth table plus the TrustEnforcer short-circuit, against the REAL
// resolvePermissions + TrustEnforcer (never mocked).

describe('unrestricted bypass — gated and default-deny', () => {
  it('(a) omitted requestUnrestricted ⇒ unrestricted=false, normal default-deny', () => {
    const policy = resolvePermissions(undefined, undefined)
    expect(policy.unrestricted).toBe(false)
    const e = new TrustEnforcer(policy)
    expect(e.canExec('rm').allow).toBe(false)
    expect(e.canCallTool('gh.delete_repo').allow).toBe(false)
    expect(e.canFetch('evil.example.com').allow).toBe(false)
    expect(e.canRead('/etc/passwd').allow).toBe(false)
  })

  it('(b) requested but NOT operator-granted ⇒ unrestricted=false (no self-escalation)', () => {
    const policy = resolvePermissions({ requestUnrestricted: true }, { requestUnrestricted: true })
    expect(policy.unrestricted).toBe(false)
    const e = new TrustEnforcer(policy)
    expect(e.canExec('rm').allow).toBe(false)
    expect(e.canCallTool('any.tool').allow).toBe(false)
  })

  it('(c) requested AND operator-granted ⇒ unrestricted=true, every dimension allows', () => {
    const policy = resolvePermissions(
      { requestUnrestricted: true },
      undefined,
      {},
      {
        grantUnrestricted: true,
      },
    )
    expect(policy.unrestricted).toBe(true)
    const e = new TrustEnforcer(policy)
    expect(e.canExec('/tmp/evil/git').allow).toBe(true)
    expect(e.canCallTool('gh.delete_repo').allow).toBe(true)
    expect(e.canAttachMcpServer('shell').allow).toBe(true)
    expect(e.canLoadSkill('anything').allow).toBe(true)
    expect(e.canAccessSecret('OPENAI_API_KEY').allow).toBe(true)
    expect(e.canFetch('evil.example.com').allow).toBe(true)
    expect(e.canRead('/etc/passwd').allow).toBe(true)
    expect(e.canWrite('/usr/bin/anything').allow).toBe(true)
    expect(e.canUseAgentmemory('save').allow).toBe(true)
  })

  it('(d) operator-granted but NOT requested ⇒ unrestricted=false (no accidental bypass)', () => {
    const policy = resolvePermissions(undefined, undefined, {}, { grantUnrestricted: true })
    expect(policy.unrestricted).toBe(false)
    expect(new TrustEnforcer(policy).canExec('rm').allow).toBe(false)
  })

  it('(e) bypass is a short-circuit, NOT a widened allow-list', () => {
    const policy = resolvePermissions(
      { requestUnrestricted: true, allowedExecutables: ['git'] },
      undefined,
      {},
      { grantUnrestricted: true },
    )
    // The resolved allow-lists stay exactly as intersected — only `git` is
    // listed — so disabling the flag would immediately restore default-deny.
    expect([...policy.allowedExecutables]).toEqual(['git'])
    expect(policy.allowedTools.star).toBe(false)
    expect(policy.networkEgress).toBe('deny')
    expect(policy.unrestricted).toBe(true)
  })

  it('createPolicyFetch bypasses the host check when unrestricted', async () => {
    let called: string | undefined
    const base = (async (input: RequestInfo | URL) => {
      called = typeof input === 'string' ? input : input.toString()
      return new Response('ok')
    }) as typeof fetch
    const policy = resolvePermissions(
      { requestUnrestricted: true },
      undefined,
      {},
      {
        grantUnrestricted: true,
      },
    )
    const f = createPolicyFetch(new TrustEnforcer(policy), undefined, base)
    await f('https://blocked.example.com/x')
    expect(called).toBe('https://blocked.example.com/x')
  })

  it('createPolicyFetch still denies when not unrestricted', async () => {
    const policy = resolvePermissions({ requestUnrestricted: true }, undefined) // no grant
    const f = createPolicyFetch(new TrustEnforcer(policy))
    await expect(f('https://blocked.example.com/x')).rejects.toThrow()
  })
})
