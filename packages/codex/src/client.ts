/**
 * Thin wrapper around `@openai/codex-sdk`'s `Codex` and `Thread`.
 *
 * - Owns a memoized `Codex` instance keyed by the constructed options. The
 *   SDK spawns the `codex` CLI per turn, but we want each backend instance
 *   to share auth/env/config across calls.
 * - Translates `Codex` JSONL events into a normalized shape the backend
 *   can publish onto skelm's event bus and `onPartial` callback.
 */

import { Codex, type CodexOptions, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import { BackendUpstreamError } from '@skelm/core'

import type { CodexBackendOptions } from './types.js'

/** Build CodexOptions from CodexBackendOptions + per-run overrides. */
export function buildCodexOptions(
  opts: CodexBackendOptions,
  overrides: { env?: Record<string, string>; config?: Record<string, unknown> } = {},
): CodexOptions {
  const out: CodexOptions = {}
  if (opts.codexPathOverride !== undefined) out.codexPathOverride = opts.codexPathOverride
  if (opts.baseUrl !== undefined) out.baseUrl = opts.baseUrl
  if (opts.apiKey !== undefined) out.apiKey = opts.apiKey

  // env: merge skelm proxyEnv with the user's static env. The SDK does NOT
  // inherit process.env when env is set, so we must replay any vars the
  // codex CLI needs from the parent unless the caller opts out.
  if (overrides.env !== undefined || opts.env !== undefined) {
    const merged: Record<string, string> = {}
    // Inherit common auth-relevant vars from process.env unless the user
    // pinned env themselves.
    if (opts.env === undefined) {
      const passthrough = [
        'HOME',
        'PATH',
        'USER',
        'CODEX_API_KEY',
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
      ]
      for (const k of passthrough) {
        const v = process.env[k]
        if (v !== undefined) merged[k] = v
      }
    } else {
      for (const [k, v] of Object.entries(opts.env)) merged[k] = v
    }
    if (overrides.env !== undefined) {
      for (const [k, v] of Object.entries(overrides.env)) merged[k] = v
    }
    out.env = merged
  }

  if (overrides.config !== undefined) {
    out.config = overrides.config as NonNullable<CodexOptions['config']>
  }
  return out
}

/** Build ThreadOptions for `Codex.startThread`. */
export function buildThreadOptions(
  opts: CodexBackendOptions,
  extras: Partial<ThreadOptions>,
): ThreadOptions {
  const out: ThreadOptions = {}
  if (opts.model !== undefined) out.model = opts.model
  if (opts.modelReasoningEffort !== undefined) out.modelReasoningEffort = opts.modelReasoningEffort
  if (opts.skipGitRepoCheck !== undefined) out.skipGitRepoCheck = opts.skipGitRepoCheck
  else out.skipGitRepoCheck = true
  Object.assign(out, extras)
  return out
}

/**
 * Translate a skelm `McpServerConfig` array into the JS shape that the
 * Codex SDK's `config.mcp_servers` accepts. Today Codex's TOML config only
 * supports stdio MCP servers via `command` + `args` + `env`; HTTP/SSE
 * transports are dropped with a warning so the caller can audit the gap.
 *
 * The caller is expected to have already filtered by `policy.allowedMcpServers`.
 */
export function buildMcpServerConfig(
  servers: ReadonlyArray<{
    id: string
    transport: 'stdio' | 'http' | 'sse'
    command?: string
    args?: readonly string[]
    env?: Readonly<Record<string, string>>
    url?: string
  }>,
): { mcp_servers: Record<string, unknown>; dropped: string[] } | null {
  if (servers.length === 0) return null
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const s of servers) {
    if (s.transport === 'stdio' && s.command !== undefined) {
      const entry: Record<string, unknown> = { command: s.command }
      if (s.args !== undefined) entry.args = [...s.args]
      if (s.env !== undefined) entry.env = { ...s.env }
      out[s.id] = entry
    } else {
      // Codex CLI's stable config.toml schema doesn't expose HTTP/SSE MCP
      // transports; users with remote MCP must wire ~/.codex/config.toml
      // manually. Surface the drop in audit instead of silently swallowing.
      dropped.push(s.id)
    }
  }
  if (Object.keys(out).length === 0) return null
  return { mcp_servers: out, dropped }
}

/**
 * Iterate the Codex event stream and dispatch normalized events. The
 * caller decides how to surface each event (onPartial, audit emission,
 * etc.). Returns the aggregated final assistant text and usage.
 */
export interface IterateResult {
  finalText: string
  usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | undefined
  stopReason: string
}

export async function consumeStream(
  events: AsyncIterable<ThreadEvent>,
  callbacks: {
    onText?: (delta: string) => void
    onItem?: (event: Extract<ThreadEvent, { type: 'item.completed' }>) => void
    onError?: (message: string) => void
  },
): Promise<IterateResult> {
  let finalText = ''
  let usage: IterateResult['usage'] = undefined
  let stopReason = 'turn.completed'
  let completed = false
  // Codex emits `error` events for TRANSIENT, recoverable conditions — most
  // notably its model-stream retry notices ("Reconnecting... N/5 (...)" from
  // codex's responses_retry loop), which it recovers from on a later attempt
  // and then finishes the turn. Treating each such notice as fatal aborted the
  // run (and the SDK's stream-cleanup then killed the codex child mid-retry),
  // surfacing as `BackendUpstreamError: codex stream error: Reconnecting...`.
  // So keep consuming on `error`: the terminal failure signal is `turn.failed`
  // (thrown below); a bare `error` only fails the turn if the stream ENDS
  // without a `turn.completed`, in which case we surface the last one.
  let lastError: string | undefined

  for await (const ev of events) {
    switch (ev.type) {
      case 'item.completed': {
        // Aggregate assistant message text. `agent_message.text` is the
        // full cumulative text up to this point — `onText` per skelm's
        // BackendContext.onPartial contract should receive *deltas*, so we
        // emit only the new suffix on each event.
        if (ev.item.type === 'agent_message') {
          const next = ev.item.text
          const delta = next.startsWith(finalText) ? next.slice(finalText.length) : next
          finalText = next
          if (delta.length > 0) callbacks.onText?.(delta)
        }
        callbacks.onItem?.(ev)
        break
      }
      case 'turn.completed':
        usage = {
          inputTokens: ev.usage.input_tokens,
          outputTokens: ev.usage.output_tokens,
          reasoningTokens: ev.usage.reasoning_output_tokens,
        }
        stopReason = 'turn.completed'
        completed = true
        // A completed turn supersedes any transient retry notice seen earlier.
        lastError = undefined
        break
      case 'turn.failed':
        stopReason = 'turn.failed'
        callbacks.onError?.(ev.error.message)
        throw new BackendUpstreamError(`codex turn failed: ${ev.error.message}`, 'codex')
      case 'error':
        // Non-fatal: a transient stream/retry notice. Surface it for audit but
        // keep consuming so codex's own retry can recover the turn.
        lastError = ev.message
        callbacks.onError?.(ev.message)
        break
      // thread.started, turn.started, item.started, item.updated: not
      // material to the final response; surface via onItem if the caller
      // wants per-item audit (it doesn't, by default).
      default:
        break
    }
  }
  // The stream ended after an `error` with no recovering `turn.completed` — now
  // it's terminal (e.g. codex exhausted its retries, "max retry times reached").
  if (!completed && lastError !== undefined) {
    stopReason = 'error'
    throw new BackendUpstreamError(`codex stream error: ${lastError}`, 'codex')
  }
  return { finalText, usage, stopReason }
}

/** Construct a `Codex` instance. Exposed for testing. */
export function makeCodexClient(opts: CodexOptions): Codex {
  return new Codex(opts)
}
