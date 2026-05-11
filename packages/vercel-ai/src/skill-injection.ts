import type { AgentRequest } from '@skelm/core'

export { loadSkillBodies } from '@skelm/core'

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
