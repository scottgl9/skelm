import { describe, it, expect } from 'vitest'
import { evaluate, EgressPolicyRegistry, type EgressPolicy } from '../../src/proxy/egress-policy.js'

describe('evaluate', () => {
  it('denies when networkEgress is deny', () => {
    const policy: EgressPolicy = { networkEgress: 'deny' }
    expect(evaluate(policy, 'api.openai.com')).toEqual({
      allow: false,
      reason: 'egress-denied',
    })
  })

  it('allows when networkEgress is allow', () => {
    const policy: EgressPolicy = { networkEgress: 'allow' }
    expect(evaluate(policy, 'anything.example.com')).toEqual({ allow: true })
  })

  it('allows listed host', () => {
    const policy: EgressPolicy = {
      networkEgress: { allowHosts: ['api.openai.com'] },
    }
    expect(evaluate(policy, 'api.openai.com')).toEqual({ allow: true })
  })

  it('denies unlisted host', () => {
    const policy: EgressPolicy = {
      networkEgress: { allowHosts: ['api.openai.com'] },
    }
    expect(evaluate(policy, 'evil.example.com')).toEqual({
      allow: false,
      reason: 'not-in-allowlist',
    })
  })

  it('allows wildcard subdomain match', () => {
    const policy: EgressPolicy = {
      networkEgress: { allowHosts: ['*.openai.com'] },
    }
    expect(evaluate(policy, 'api.openai.com')).toEqual({ allow: true })
    expect(evaluate(policy, 'files.openai.com')).toEqual({ allow: true })
  })

  it('allows exact match for wildcard base domain', () => {
    const policy: EgressPolicy = {
      networkEgress: { allowHosts: ['*.openai.com'] },
    }
    expect(evaluate(policy, 'openai.com')).toEqual({ allow: true })
  })

  it('denies non-matching host against wildcard', () => {
    const policy: EgressPolicy = {
      networkEgress: { allowHosts: ['*.openai.com'] },
    }
    expect(evaluate(policy, 'notopen.ai.com')).toEqual({
      allow: false,
      reason: 'not-in-allowlist',
    })
  })
})

describe('EgressPolicyRegistry', () => {
  it('registers and resolves a token', () => {
    const registry = new EgressPolicyRegistry()
    registry.register('tok1', { networkEgress: 'allow', runId: 'r1', stepId: 's1' })
    expect(registry.resolve('tok1')).toEqual({
      networkEgress: 'allow',
      runId: 'r1',
      stepId: 's1',
    })
  })

  it('returns undefined for unknown token', () => {
    const registry = new EgressPolicyRegistry()
    expect(registry.resolve('unknown')).toBeUndefined()
  })

  it('revokes a token', () => {
    const registry = new EgressPolicyRegistry()
    registry.register('tok2', { networkEgress: 'deny' })
    registry.revoke('tok2')
    expect(registry.resolve('tok2')).toBeUndefined()
  })
})
