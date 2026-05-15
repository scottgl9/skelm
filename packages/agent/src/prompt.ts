/**
 * Agent-package surface for the system-prompt builder.
 *
 * The builder itself lives in @skelm/core/system-prompt so it can be shared
 * with other backends (e.g. anthropic) without creating a reverse dependency.
 * This module re-exports the public API and adds the agent-only `toUsage`
 * helper.
 */

import type { Usage } from '@skelm/core/backend'

import type { OpenAIChatResponse } from './http-client.js'

export {
  DEFAULT_SECTIONS_MAX_CHARS,
  buildSystemPrompt,
  buildSystemPromptFromRequest,
  type SystemPromptInput,
} from '@skelm/core/system-prompt'

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
