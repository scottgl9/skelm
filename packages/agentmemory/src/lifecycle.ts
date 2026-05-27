import type { AgentmemoryHandle, ContentPart } from '@skelm/core'

/**
 * Helpers backends use to wrap an opaque agent turn with agentmemory.
 *
 * The three hooks fire in order:
 *   1. `startMemoryTurn` opens the session and runs `smartSearch` on the
 *      user prompt, returning a `recallPrefix` to prepend to the backend's
 *      system prompt.
 *   2. The backend runs its own agent loop / SDK call.
 *   3. `recordMemoryTurn` observes the final assistant text.
 *   4. `endMemoryTurn` closes the session in `finally`.
 *
 * Every function is a no-op when the handle is undefined and never throws
 * — backends do not need to guard or try/catch the calls.
 */

export interface MemoryTurnInit {
  sessionId: string
  project?: string
  cwd?: string
  promptText: string
}

export interface MemoryTurnResult {
  sessionId: string
  recallPrefix: string
}

export async function startMemoryTurn(
  handle: AgentmemoryHandle | undefined,
  opts: MemoryTurnInit,
): Promise<MemoryTurnResult> {
  if (handle === undefined) return { sessionId: opts.sessionId, recallPrefix: '' }
  const sessionInput: Parameters<AgentmemoryHandle['startSession']>[0] = { sessionId: opts.sessionId }
  if (opts.project !== undefined) sessionInput.project = opts.project
  if (opts.cwd !== undefined) sessionInput.cwd = opts.cwd
  await handle.startSession(sessionInput)
  if (opts.promptText.length === 0) return { sessionId: opts.sessionId, recallPrefix: '' }
  const recall = await handle.smartSearch({
    query: opts.promptText,
    limit: 5,
    sessionId: opts.sessionId,
  })
  if (recall.hits.length === 0) return { sessionId: opts.sessionId, recallPrefix: '' }
  const lines = recall.hits
    .slice(0, 5)
    .map((h) => `- ${h.title}: ${h.content.slice(0, 240)}`)
  const recallPrefix = `<memory>\nRelevant prior context:\n${lines.join('\n')}\n</memory>\n\n`
  return { sessionId: opts.sessionId, recallPrefix }
}

export interface MemoryTurnRecord {
  sessionId: string
  project?: string
  cwd?: string
  resultText: string
  hookType?: string
}

export async function recordMemoryTurn(
  handle: AgentmemoryHandle | undefined,
  opts: MemoryTurnRecord,
): Promise<void> {
  if (handle === undefined) return
  const input: Parameters<AgentmemoryHandle['observe']>[0] = {
    sessionId: opts.sessionId,
    hookType: opts.hookType ?? 'task_completed',
    data: { result: opts.resultText.slice(0, 8000) },
  }
  if (opts.project !== undefined) input.project = opts.project
  if (opts.cwd !== undefined) input.cwd = opts.cwd
  await handle.observe(input)
}

export async function endMemoryTurn(
  handle: AgentmemoryHandle | undefined,
  sessionId: string,
): Promise<void> {
  if (handle === undefined) return
  await handle.endSession({ sessionId }).catch(() => {})
}

/** Stable session id derived from request fields with sane fallbacks. */
export function deriveSessionId(
  req: { sessionId?: string },
  ctx: { runId?: string; stepId?: string },
): string {
  if (req.sessionId !== undefined) return req.sessionId
  const run = ctx.runId ?? `r-${Date.now().toString(36)}`
  const step = ctx.stepId ?? 'agent'
  return `skelm-${run}-${step}`
}

/** Extract the text portion of an AgentRequest.prompt for memory search. */
export function extractPromptText(prompt: string | readonly ContentPart[]): string {
  if (typeof prompt === 'string') return prompt.slice(0, 1024)
  return prompt
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join(' ')
    .slice(0, 1024)
}
