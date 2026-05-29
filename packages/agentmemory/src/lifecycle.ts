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
  const sessionInput: Parameters<AgentmemoryHandle['startSession']>[0] = {
    sessionId: opts.sessionId,
  }
  if (opts.project !== undefined) sessionInput.project = opts.project
  if (opts.cwd !== undefined) sessionInput.cwd = opts.cwd
  await handle.startSession(sessionInput)
  if (opts.promptText.length === 0) return { sessionId: opts.sessionId, recallPrefix: '' }
  // Capture the user prompt itself as memory (gated by the `observe` op;
  // a no-op when observe is denied), not just tool calls and final results.
  const observeInput: Parameters<AgentmemoryHandle['observe']>[0] = {
    sessionId: opts.sessionId,
    hookType: 'user_prompt_submit',
    data: { prompt: opts.promptText },
  }
  if (opts.project !== undefined) observeInput.project = opts.project
  if (opts.cwd !== undefined) observeInput.cwd = opts.cwd
  await handle.observe(observeInput)
  const recall = await handle.smartSearch({
    query: opts.promptText,
    limit: 5,
    sessionId: opts.sessionId,
  })
  if (recall.hits.length === 0) return { sessionId: opts.sessionId, recallPrefix: '' }
  const lines = recall.hits.slice(0, 5).map((h) => `- ${h.title}: ${h.content.slice(0, 240)}`)
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

export interface RunWithMemoryOptions {
  readonly handle: AgentmemoryHandle | undefined
  readonly runId?: string
  readonly stepId?: string
  /** Stable string forwarded to start/record/end as the project + cwd. */
  readonly project: string
}

export interface RunWithMemoryInnerParams {
  readonly sessionId: string
  /** Caller prepends this to its system prompt; empty string when no hits. */
  readonly recallPrefix: string
}

export interface RunWithMemoryInnerResult<T> {
  /** The backend-shaped result returned to the caller of runWithMemoryTurns. */
  readonly result: T
  /** Text recorded into the memory turn observation; pass '' to skip. */
  readonly resultText: string
}

/**
 * Wrap an inner backend run with the start/observe → run → record → end
 * lifecycle. Replaces the same boilerplate previously duplicated in
 * @skelm/agent, codex, opencode, pi, and vercel-ai backends.
 *
 * The inner callback receives the recall prefix that should be prepended
 * to the backend's system prompt (empty string when the handle is
 * undefined or no recall hits). It must return both the typed result
 * (returned through unchanged) and the text to record into the turn
 * observation.
 *
 * Behaviour matches the prior open-coded sequence exactly:
 *   - sessionId comes from `request.sessionId` or `deriveSessionId(...)`.
 *   - startMemoryTurn opens the session and runs smartSearch.
 *   - recordMemoryTurn fires on success only.
 *   - endMemoryTurn fires in `finally` on both success and failure.
 */
export async function runWithMemoryTurns<T>(
  opts: RunWithMemoryOptions,
  request: { sessionId?: string; prompt: string | readonly ContentPart[] },
  inner: (params: RunWithMemoryInnerParams) => Promise<RunWithMemoryInnerResult<T>>,
): Promise<T> {
  const sessionId = deriveSessionId(request, {
    ...(opts.runId !== undefined && { runId: opts.runId }),
    ...(opts.stepId !== undefined && { stepId: opts.stepId }),
  })
  const turn = await startMemoryTurn(opts.handle, {
    sessionId,
    project: opts.project,
    cwd: opts.project,
    promptText: extractPromptText(request.prompt),
  })
  try {
    const { result, resultText } = await inner({
      sessionId: turn.sessionId,
      recallPrefix: turn.recallPrefix,
    })
    await recordMemoryTurn(opts.handle, {
      sessionId: turn.sessionId,
      project: opts.project,
      cwd: opts.project,
      resultText,
    })
    return result
  } finally {
    await endMemoryTurn(opts.handle, turn.sessionId)
  }
}
