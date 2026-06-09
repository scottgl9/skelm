import { describe, expect, it } from 'vitest'
import type { AgentmemoryOperation } from '../../src/permissions.js'
import { makeEnforcer } from '../../src/testing/permissions.js'

// Adversarial coverage for the `agentmemory` permission dimension.
//
// Default-deny: omitting `permissions.agentmemory` denies every observe /
// search / session / context call. Explicit-deny: a policy that grants one
// op denies every other op. `'deny'` shorthand zeroes the whole dimension
// even when defaults granted it.

const ALL_OPS: readonly AgentmemoryOperation[] = [
  'observe',
  'search',
  'session',
  'context',
  'save',
  'recall',
  'graph',
]

describe('agentmemory permission — default-deny', () => {
  it('omitted permissions denies every agentmemory op', () => {
    const enforcer = makeEnforcer(undefined, undefined)
    for (const op of ALL_OPS) {
      const decision = enforcer.canUseAgentmemory(op)
      expect(decision.allow).toBe(false)
      if (!decision.allow) {
        expect(decision.dimension).toBe('agentmemory')
        expect(decision.reason).toBe('not-in-allowlist')
      }
    }
  })

  it('omitted agentmemory field on an otherwise-populated step denies every op', () => {
    const enforcer = makeEnforcer(undefined, { allowedTools: ['*'] })
    for (const op of ALL_OPS) {
      expect(enforcer.canUseAgentmemory(op).allow).toBe(false)
    }
  })

  it("'deny' shorthand denies every op even when defaults granted it", () => {
    const enforcer = makeEnforcer(
      { agentmemory: { allowObserve: true, allowSearch: true } },
      { agentmemory: 'deny' },
    )
    for (const op of ALL_OPS) {
      expect(enforcer.canUseAgentmemory(op).allow).toBe(false)
    }
  })

  it('empty agentmemory object grants nothing — denies every op', () => {
    const enforcer = makeEnforcer({ agentmemory: {} }, { agentmemory: {} })
    for (const op of ALL_OPS) {
      expect(enforcer.canUseAgentmemory(op).allow).toBe(false)
    }
  })
})

describe('agentmemory permission — explicit-deny', () => {
  it('granting one op denies every other op', () => {
    const enforcer = makeEnforcer(undefined, { agentmemory: { allowSearch: true } })
    expect(enforcer.canUseAgentmemory('search').allow).toBe(true)
    for (const op of ALL_OPS.filter((o) => o !== 'search')) {
      const decision = enforcer.canUseAgentmemory(op)
      expect(decision.allow).toBe(false)
      if (!decision.allow) expect(decision.dimension).toBe('agentmemory')
    }
  })

  it('granting a broadened op (save) denies every other op', () => {
    const enforcer = makeEnforcer(undefined, { agentmemory: { allowSave: true } })
    expect(enforcer.canUseAgentmemory('save').allow).toBe(true)
    for (const op of ALL_OPS.filter((o) => o !== 'save')) {
      expect(enforcer.canUseAgentmemory(op).allow).toBe(false)
    }
  })

  it('recall and graph are independently gated', () => {
    const recallOnly = makeEnforcer(undefined, { agentmemory: { allowRecall: true } })
    expect(recallOnly.canUseAgentmemory('recall').allow).toBe(true)
    expect(recallOnly.canUseAgentmemory('graph').allow).toBe(false)

    const graphOnly = makeEnforcer(undefined, { agentmemory: { allowGraph: true } })
    expect(graphOnly.canUseAgentmemory('graph').allow).toBe(true)
    expect(graphOnly.canUseAgentmemory('recall').allow).toBe(false)
  })

  it('intersection narrows: defaults allow all, step allows only observe', () => {
    const enforcer = makeEnforcer(
      {
        agentmemory: {
          allowObserve: true,
          allowSearch: true,
          allowSession: true,
          allowContext: true,
        },
      },
      { agentmemory: { allowObserve: true } },
    )
    expect(enforcer.canUseAgentmemory('observe').allow).toBe(true)
    expect(enforcer.canUseAgentmemory('search').allow).toBe(false)
    expect(enforcer.canUseAgentmemory('session').allow).toBe(false)
    expect(enforcer.canUseAgentmemory('context').allow).toBe(false)
  })

  it('cannot widen: step alone cannot grant an op defaults did not', () => {
    const enforcer = makeEnforcer(
      { agentmemory: { allowObserve: true } },
      { agentmemory: { allowObserve: true, allowSearch: true } },
    )
    expect(enforcer.canUseAgentmemory('observe').allow).toBe(true)
    expect(enforcer.canUseAgentmemory('search').allow).toBe(false)
  })
})
