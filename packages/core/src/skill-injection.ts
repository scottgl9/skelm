import type { AgentRequest, BackendContext } from './backend.js'
import { formatSkillBlock } from './skills.js'

/**
 * Load skill bodies via ctx.loadSkill (which itself enforces allowedSkills).
 * Skills that resolve to null are skipped silently — same convention across
 * all skelm backends.
 */
export async function loadSkillBodies(req: AgentRequest, ctx: BackendContext): Promise<string[]> {
  if (!req.skills || req.skills.length === 0 || !ctx.loadSkill) return []
  const bodies: string[] = []
  for (const skillId of req.skills) {
    const skill = await ctx.loadSkill(skillId)
    if (skill !== null) bodies.push(formatSkillBlock(skill))
  }
  return bodies
}
