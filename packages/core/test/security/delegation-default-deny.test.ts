import { describe, expect, it } from 'vitest'
import { makeEnforcer } from '../../src/testing/permissions.js'

describe('delegation permission — default-deny', () => {
  it('omitted delegation field denies every target', () => {
    const enforcer = makeEnforcer(undefined, undefined)
    const decision = enforcer.canDelegate('research.agent')
    expect(decision.allow).toBe(false)
    if (!decision.allow) {
      expect(decision.dimension).toBe('delegation')
      expect(decision.reason).toBe('not-in-allowlist')
    }
  })

  it('omitted delegation on an otherwise-populated step still denies', () => {
    const enforcer = makeEnforcer(undefined, { allowedTools: ['*'], networkEgress: 'allow' })
    expect(enforcer.canDelegate('anything.agent').allow).toBe(false)
  })

  it('explicit allowlist denies any target not on it', () => {
    const enforcer = makeEnforcer(undefined, { delegation: ['research.agent'] })
    expect(enforcer.canDelegate('research.agent').allow).toBe(true)
    const denied = enforcer.canDelegate('shell.agent')
    expect(denied.allow).toBe(false)
    if (!denied.allow) expect(denied.dimension).toBe('delegation')
  })

  it('a step cannot widen the project default delegation allowlist', () => {
    // Default permits two agents; the step's allowlist intersects, never unions.
    const enforcer = makeEnforcer(
      { delegation: ['research.agent', 'writer.agent'] },
      { delegation: ['writer.agent', 'attacker.agent'] },
    )
    expect(enforcer.canDelegate('writer.agent').allow).toBe(true)
    expect(enforcer.canDelegate('research.agent').allow).toBe(false)
    expect(enforcer.canDelegate('attacker.agent').allow).toBe(false)
  })
})
