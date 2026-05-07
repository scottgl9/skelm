import { type AgentRequest, type BackendContext, formatSkillBlock } from '@skelm/core'

/**
 * Load skill bodies via ctx.loadSkill (which itself enforces allowedSkills).
 * Skipped silently when a skill returns null — same convention as pi-sdk.
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

/**
 * Assemble the system prompt for an agent run.
 * Order: options.systemPrompt → agentDef.soul → agentDef.instructions → req.system → skills.
 */
export function buildSystemContent(
  systemBase: string | undefined,
  req: AgentRequest,
  skillBodies: readonly string[],
): string | undefined {
  const parts: string[] = []
  if (systemBase !== undefined) parts.push(systemBase)
  if (req.agentDef?.soul !== undefined) parts.push(req.agentDef.soul)
  if (req.agentDef !== undefined) parts.push(req.agentDef.instructions)
  if (req.system) parts.push(req.system)
  for (const body of skillBodies) parts.push(body)
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined
}
