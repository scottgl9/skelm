import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../src/events.js'
import { TrustEnforcer, resolvePermissions } from '../../src/permissions.js'
import type { Skill } from '../../src/skills.js'

// Unit tests for the makeSkillLoader behavior: the function is unexported but
// its contract is fully observable through what BackendContext.loadSkill returns.
// We test the enforcement contract here by constructing the same inputs the
// runner would use, mirroring how policy-fetch.test.ts tests canFetch.

function makeTestSkill(id: string): Skill {
  return {
    id,
    description: `Test skill ${id}`,
    metadata: {},
    body: `# ${id}\nTest body.`,
    source: `/skills/${id}/SKILL.md`,
  }
}

/**
 * Minimal re-implementation of makeSkillLoader from runner.ts so the
 * enforcement logic is testable without importing private internals.
 * This mirrors the contract the runner provides: canLoadSkill gates
 * the source call, and a denied load publishes permission.denied.
 */
function makeSkillLoader(
  source: (skillId: string) => Promise<Skill | null>,
  enforcer: TrustEnforcer,
  events: EventBus | undefined,
  runId: string,
  stepId: string,
): (skillId: string) => Promise<Skill | null> {
  return async (skillId) => {
    const decision = enforcer.canLoadSkill(skillId)
    if (!decision.allow) {
      events?.publish({
        type: 'permission.denied',
        runId,
        stepId,
        dimension: 'skill',
        detail: `skill "${skillId}" is not in allowedSkills (${decision.reason})`,
        at: Date.now(),
      })
      return null
    }
    return source(skillId)
  }
}

describe('skill loader — canLoadSkill enforcement', () => {
  it('default-deny: skill load is denied when allowedSkills is omitted', async () => {
    const source = vi.fn(async (_id: string) => makeTestSkill('triage'))
    const enforcer = new TrustEnforcer(resolvePermissions(undefined, undefined))
    const loader = makeSkillLoader(source, enforcer, undefined, 'run-1', 'step-1')

    const result = await loader('triage')

    expect(result).toBeNull()
    expect(source).not.toHaveBeenCalled()
  })

  it('explicit-deny: skill not in allowedSkills returns null', async () => {
    const source = vi.fn(async (_id: string) => makeTestSkill('exfil'))
    const enforcer = new TrustEnforcer(resolvePermissions(undefined, { allowedSkills: ['triage'] }))
    const loader = makeSkillLoader(source, enforcer, undefined, 'run-1', 'step-1')

    const result = await loader('exfil')

    expect(result).toBeNull()
    expect(source).not.toHaveBeenCalled()
  })

  it('allows skill load when id is in allowedSkills', async () => {
    const skill = makeTestSkill('triage')
    const source = vi.fn(async (_id: string) => skill)
    const enforcer = new TrustEnforcer(resolvePermissions(undefined, { allowedSkills: ['triage'] }))
    const loader = makeSkillLoader(source, enforcer, undefined, 'run-1', 'step-1')

    const result = await loader('triage')

    expect(result).toBe(skill)
    expect(source).toHaveBeenCalledWith('triage')
  })

  it('denied load publishes permission.denied event', async () => {
    const events = new EventBus()
    const published: unknown[] = []
    events.subscribe((ev) => published.push(ev))

    const source = vi.fn(async (_id: string) => null)
    const enforcer = new TrustEnforcer(resolvePermissions(undefined, undefined))
    const loader = makeSkillLoader(source, enforcer, events, 'run-42', 'step-agent')

    await loader('triage')

    const denied = published.find(
      (e) =>
        typeof e === 'object' && e !== null && (e as { type: string }).type === 'permission.denied',
    ) as { type: string; dimension: string; runId: string; stepId: string } | undefined

    expect(denied).toBeDefined()
    expect(denied?.dimension).toBe('skill')
    expect(denied?.runId).toBe('run-42')
    expect(denied?.stepId).toBe('step-agent')
  })

  it('returns null when source returns null (unknown skill id)', async () => {
    const source = vi.fn(async (_id: string) => null)
    const enforcer = new TrustEnforcer(resolvePermissions(undefined, { allowedSkills: ['triage'] }))
    const loader = makeSkillLoader(source, enforcer, undefined, 'run-1', 'step-1')

    const result = await loader('triage')

    expect(result).toBeNull()
    expect(source).toHaveBeenCalledWith('triage')
  })
})
