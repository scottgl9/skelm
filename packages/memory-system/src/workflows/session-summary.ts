import type { MemorySystemConfig } from '../config.js'
import { MemorySystemError } from '../errors.js'
import type { MemorySystemDeps, WorkflowOutcome } from '../types.js'
import { logOf, outcome } from './shared.js'

/**
 * Summarize one session's memories into a single durable summary memory using
 * the injected `Summarizer` (an agent/infer turn in production, a stub in
 * tests). Recalls the session's memories, summarizes their text, and saves the
 * summary tagged `session-summary` + the session id.
 *
 * Requires `allowRecall` + `allowSave` and a configured `summarizer`.
 */
export async function runSessionSummary(
  deps: MemorySystemDeps,
  config: MemorySystemConfig,
  input: { sessionId: string },
): Promise<WorkflowOutcome> {
  const log = logOf(deps, 'session-summary')
  if (deps.summarizer === undefined) {
    throw new MemorySystemError('session-summary requires a summarizer dependency')
  }
  const recall = await deps.memory.recall({
    project: config.project,
    sessionId: input.sessionId,
    limit: config.recallLimit,
  })
  const hits = recall.hits
  if (hits.length === 0) {
    log('no memories for session', { sessionId: input.sessionId })
    return outcome('session-summary', { summarized: 0, recalled: 0 })
  }

  const transcript = hits.map((h) => `${h.title}: ${h.content}`).join('\n')
  const summary = await deps.summarizer.summarize({
    text: transcript,
    instructions:
      'Summarize this agent session into durable, reusable facts. Keep it under a paragraph.',
  })
  const saved = await deps.memory.save({
    project: config.project,
    sessionId: input.sessionId,
    title: `Session summary ${input.sessionId}`,
    content: summary,
    concepts: ['session-summary', input.sessionId],
  })
  log('saved session summary', { sessionId: input.sessionId, id: saved.id })
  return outcome('session-summary', {
    summarized: saved.id.length > 0 ? 1 : 0,
    recalled: hits.length,
  })
}
