import type { AgentRequest } from '@skelm/core/backend'
import type { Usage } from '@skelm/core/backend'

import type { OpenAIChatResponse } from './http-client.js'

export function toUsage(usage?: OpenAIChatResponse['usage']): Usage | undefined {
  if (!usage) return undefined
  return {
    ...(usage.prompt_tokens !== undefined && { inputTokens: usage.prompt_tokens }),
    ...(usage.completion_tokens !== undefined && { outputTokens: usage.completion_tokens }),
    ...(usage.total_tokens !== undefined && {
      extras: { totalTokens: usage.total_tokens },
    }),
  }
}

export function buildSystemPrompt(
  req: AgentRequest,
  cwd: string,
  hasMcpServers: boolean,
  toolCount: number,
): string {
  const parts: string[] = []

  if (req.agentDef) {
    if (req.agentDef.soul) {
      parts.push(`# SOUL.md\n${req.agentDef.soul}`)
    }
    parts.push(`# AGENTS.md\n${req.agentDef.instructions}`)
  }

  if (req.system) {
    parts.push(`# Instructions\n${req.system}`)
  }

  parts.push(
    `\n# Tool Use\n\nYou have access to ${toolCount} tool(s). Use them when appropriate.\nYour working directory is: ${cwd}\nWhen you need to use a tool, issue a tool call. When the task is complete, respond with your final answer.`,
  )

  if (hasMcpServers) {
    parts.push(
      '\nYou may also have access to MCP servers with additional tools. Use those when appropriate.',
    )
  }

  return parts.join('\n\n---\n\n')
}
