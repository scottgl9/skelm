/**
 * Compaction primitives for AgentSession.
 *
 * Compaction in skelm is pipeline-driven, not interactive: we trim and
 * summarize history when (a) the input token budget for the next step is
 * tight, or (b) the serialized payload is approaching the run store's
 * per-row limit. Both knobs are exposed on `ShouldCompactOptions`.
 *
 * All functions here are pure — they take a session/messages snapshot and
 * return a new one. The AgentSession instance is mutated only by the caller
 * via `setMessages()` after consulting `compact()`.
 */

import type { AgentSession, SerializedSession } from './agent-session.js'
import type { SessionMessage } from './messages.js'

/**
 * Approximation of OpenAI's cl100k tokenizer. Error band is roughly ±15% on
 * English prose; treat the result as a budgeting heuristic, never as a
 * billing input. Cheap enough to call on every turn.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  // 1 token ≈ 4 chars for English; round up so short strings always cost 1.
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: readonly SessionMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += estimateTokens(m.content)
    // Per-message framing overhead the model pays for role/separator tokens.
    total += 4
    if (m.toolCalls !== undefined) {
      for (const tc of m.toolCalls) {
        total += estimateTokens(tc.name) + estimateTokens(tc.arguments)
      }
    }
  }
  return total
}

export interface ShouldCompactOptions {
  /** Model context window (input + output combined). */
  contextWindow: number
  /**
   * Trigger compaction when estimated input tokens exceed this fraction of
   * the context window. Default 0.75.
   */
  thresholdFraction?: number
  /**
   * Optional explicit token budget. When provided, compaction also fires
   * if estimated tokens exceed this number even if the context-window
   * fraction hasn't been hit. Useful for pipelines that want to leave room
   * for downstream steps.
   */
  tokenBudget?: number
  /**
   * Maximum acceptable size of the serialized session in UTF-8 bytes. When
   * exceeded, compaction fires regardless of token estimates — protects the
   * run store from oversized rows. Default 256 KiB.
   */
  payloadBytes?: number
}

export function serializedSize(session: SerializedSession | AgentSession): number {
  const json = 'toJSON' in session ? session.toJSON() : session
  return Buffer.byteLength(JSON.stringify(json), 'utf8')
}

export function shouldCompact(
  session: AgentSession | SerializedSession,
  opts: ShouldCompactOptions,
): boolean {
  const messages = 'messages' in session ? session.messages : []
  const tokens = estimateMessagesTokens(messages)
  const fraction = opts.thresholdFraction ?? 0.75
  if (tokens >= opts.contextWindow * fraction) return true
  if (opts.tokenBudget !== undefined && tokens >= opts.tokenBudget) return true
  const limit = opts.payloadBytes ?? 256 * 1024
  if (serializedSize(session) >= limit) return true
  return false
}

export interface FindCutPointOptions {
  /** Keep the most recent N turns verbatim. Default 4. */
  keepRecent?: number
  /**
   * Never cut into a system message at index 0 — it carries the original
   * system prompt the caller installed when the session was created.
   * Default true.
   */
  preserveSystem?: boolean
}

/**
 * Returns the message index where the kept-verbatim suffix starts. Messages
 * before that index are candidates for summarization; messages at or after
 * are kept verbatim. Returns 0 when no compaction is warranted.
 *
 * When `preserveSystem` is true (the default) and `messages[0].role` is
 * `'system'`, that leading system message is treated as fixed prefix — it
 * never participates in the summarized range, and the keepRecent budget is
 * computed against the remaining tail. `compact()` honors the same rule
 * and emits `[messages[0], summary, ...suffix]`.
 *
 * Examples (with keepRecent=2):
 *  - [user, assistant, user, assistant] → 2 (keep last two)
 *  - [user, assistant] → 0 (already shorter than keepRecent)
 *  - [system, user, assistant, user, assistant] with preserveSystem
 *    → 3 (summary slot replaces messages[1..3))
 *  - [system, user, assistant] with preserveSystem
 *    → 0 (tail too short to summarize)
 */
export function findCutPoint(
  messages: readonly SessionMessage[],
  opts: FindCutPointOptions = {},
): number {
  const keep = opts.keepRecent ?? 4
  const preserve = (opts.preserveSystem ?? true) && messages[0]?.role === 'system' ? 1 : 0
  const tailLength = messages.length - preserve
  if (tailLength <= keep) return 0
  return messages.length - keep
}

export interface CompactOptions extends FindCutPointOptions {
  /**
   * Called to produce a summary of the messages being collapsed. Receives
   * the slice to be summarized and returns the summary text. Implementors
   * should keep the summary short — long summaries defeat the point.
   */
  summarize: (toSummarize: readonly SessionMessage[]) => Promise<string>
  signal?: AbortSignal
}

export interface CompactionResult {
  /** Replacement message list to install via session.setMessages(). */
  messages: SessionMessage[]
  /** Number of original messages that were collapsed into the summary. */
  collapsedCount: number
  /** Estimated token saving vs the original (positive = saved). */
  estimatedTokenSavings: number
}

/**
 * Produce a compacted message list by collapsing the prefix into a single
 * `system` summary message and preserving the most recent turns verbatim.
 */
export async function compact(
  messages: readonly SessionMessage[],
  opts: CompactOptions,
): Promise<CompactionResult> {
  const cut = findCutPoint(messages, opts)
  if (cut === 0) {
    return { messages: [...messages], collapsedCount: 0, estimatedTokenSavings: 0 }
  }

  const preserveSystem = (opts.preserveSystem ?? true) && messages[0]?.role === 'system'
  const preservedHead = preserveSystem ? messages.slice(0, 1) : []
  const prefix = messages.slice(preservedHead.length, cut)
  const suffix = messages.slice(cut)

  if (prefix.length === 0) {
    return { messages: [...messages], collapsedCount: 0, estimatedTokenSavings: 0 }
  }

  const beforeTokens = estimateMessagesTokens(prefix)
  const summary = await opts.summarize(prefix)
  const summaryMsg: SessionMessage = {
    role: 'system',
    content: `Earlier conversation summary:\n${summary}`,
  }
  const afterTokens = estimateMessagesTokens([summaryMsg])

  return {
    messages: [...preservedHead, summaryMsg, ...suffix],
    collapsedCount: prefix.length,
    estimatedTokenSavings: beforeTokens - afterTokens,
  }
}
