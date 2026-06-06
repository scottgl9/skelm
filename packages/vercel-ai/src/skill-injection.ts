import { type AgentRequest, buildSystemPromptFromRequest } from '@skelm/core'

export { loadSkillBodies } from '@skelm/core'

/**
 * Assemble the system prompt for an agent run. The agentDef / user-system
 * portion uses the shared core builder so systemPromptMode and
 * systemPromptIncludeAgentDef match the native-agent and Anthropic backends.
 */
export function buildSystemContent(
  systemBase: string | undefined,
  req: AgentRequest,
  skillBodies: readonly string[],
): string | undefined {
  const parts: string[] = []
  if (systemBase !== undefined) parts.push(systemBase)
  if (
    req.agentDef !== undefined ||
    req.system !== undefined ||
    req.systemPromptMode !== undefined ||
    req.systemPromptIncludeAgentDef !== undefined
  ) {
    const shared = buildSystemPromptFromRequest(req, {
      cwd: req.cwd ?? process.cwd(),
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
      tools: [],
    })
    if (shared.length > 0) parts.push(shared)
  }
  for (const body of skillBodies) parts.push(body)
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined
}
