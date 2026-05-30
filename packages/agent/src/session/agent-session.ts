/**
 * Stateful, serializable conversation context for skelm-agent.
 *
 * An AgentSession owns the message history for an agent run and exposes a
 * `prompt(text)` method that appends a user turn and dispatches a single
 * assistant turn through a caller-provided `inference` function. Tool-calling
 * is intentionally NOT folded in here — the existing backend `run()` path
 * still owns that. Sessions are for pipelines that want to thread an
 * inference-style chat across multiple agent-step invocations and persist
 * the state through the run store.
 */

import { BackendSessionError } from '@skelm/core'
import type {
  SessionEvent,
  SessionEventListener,
  SessionPromptResult,
  Unsubscribe,
} from './events.js'
import type { MessageRole, SessionMessage, SessionToolCall } from './messages.js'

/**
 * Run a single assistant turn against the supplied message history. The
 * implementation issues a chat completion (or any equivalent) and returns
 * the assistant message plus stop reason.
 */
export type InferDispatch = (args: {
  messages: readonly SessionMessage[]
  signal?: AbortSignal
  onDelta?: (text: string) => void
}) => Promise<{
  message: SessionMessage
  stopReason: SessionPromptResult['stopReason']
}>

export interface AgentSessionInit {
  systemPrompt?: string
  /** Pre-existing messages (e.g. when restoring from JSON). */
  messages?: readonly SessionMessage[]
  /** Backend metadata stored alongside the messages for diagnostics. */
  metadata?: Readonly<Record<string, unknown>>
  /**
   * Token budget hint for compaction. Stored on the session and returned in
   * `toJSON()`; the value is consulted by `compaction.shouldCompact()` but
   * the session itself does not auto-compact — call it explicitly.
   */
  tokenBudget?: number
}

export interface SerializedSession {
  /** Bumped on incompatible shape changes. */
  version: 1
  systemPrompt?: string
  messages: SessionMessage[]
  metadata?: Readonly<Record<string, unknown>>
  tokenBudget?: number
}

export interface PromptOptions {
  signal?: AbortSignal
  /** Subscribe to `message_delta` events for this prompt. Off by default. */
  streamDeltas?: boolean
}

export class AgentSession {
  private readonly _listeners = new Set<SessionEventListener>()
  private _messages: SessionMessage[] = []
  private _disposed = false
  private _abortController: AbortController | undefined
  readonly systemPrompt?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  tokenBudget?: number

  constructor(
    private readonly dispatch: InferDispatch,
    init: AgentSessionInit = {},
  ) {
    if (init.systemPrompt !== undefined) this.systemPrompt = init.systemPrompt
    if (init.metadata !== undefined) this.metadata = init.metadata
    if (init.tokenBudget !== undefined) this.tokenBudget = init.tokenBudget
    if (init.messages !== undefined) {
      this._messages = [...init.messages]
    }
  }

  get messages(): readonly SessionMessage[] {
    return this._messages
  }

  /** Replace the message history. Used by compaction. */
  setMessages(messages: readonly SessionMessage[]): void {
    this._messages = [...messages]
  }

  subscribe(listener: SessionEventListener): Unsubscribe {
    this._listeners.add(listener)
    return () => {
      this._listeners.delete(listener)
    }
  }

  private emit(event: SessionEvent): void {
    for (const l of this._listeners) {
      try {
        l(event)
      } catch {
        // Listener errors must not abort the session; they're observer code.
      }
    }
  }

  async prompt(text: string, opts: PromptOptions = {}): Promise<SessionPromptResult> {
    if (this._disposed) throw new BackendSessionError('AgentSession disposed')

    const userMsg: SessionMessage = { role: 'user', content: text }
    this._messages.push(userMsg)
    this.emit({ type: 'message_complete', message: userMsg })

    const controller = new AbortController()
    this._abortController = controller
    const onUpstreamAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onUpstreamAbort, { once: true })

    const fullHistory: SessionMessage[] = []
    // Skip prepending systemPrompt when the history already starts with a
    // system message — compaction collapses the prefix into a `system`
    // summary, and strict servers (e.g. qwen35) reject back-to-back system
    // turns. The first message wins as the effective system role.
    const historyStartsWithSystem = this._messages[0]?.role === 'system'
    if (this.systemPrompt !== undefined && !historyStartsWithSystem) {
      fullHistory.push({ role: 'system', content: this.systemPrompt })
    }
    fullHistory.push(...this._messages)

    const onDelta = opts.streamDeltas
      ? (delta: string) => this.emit({ type: 'message_delta', text: delta })
      : undefined

    let result: SessionPromptResult
    try {
      const dispatchResult = await this.dispatch({
        messages: fullHistory,
        signal: controller.signal,
        ...(onDelta !== undefined && { onDelta }),
      })
      this._messages.push(dispatchResult.message)
      this.emit({ type: 'message_complete', message: dispatchResult.message })
      result = {
        text: dispatchResult.message.content,
        stopReason: dispatchResult.stopReason,
        ...(dispatchResult.message.usage !== undefined && { usage: dispatchResult.message.usage }),
      }
    } catch (err) {
      const aborted = controller.signal.aborted
      result = {
        text: '',
        stopReason: aborted ? 'aborted' : 'error',
      }
      this.emit({ type: 'agent_end', result })
      throw err
    } finally {
      opts.signal?.removeEventListener('abort', onUpstreamAbort)
      this._abortController = undefined
    }

    this.emit({ type: 'agent_end', result })
    return result
  }

  async abort(): Promise<void> {
    this._abortController?.abort()
  }

  dispose(): void {
    this._disposed = true
    this._listeners.clear()
    this._abortController?.abort()
  }

  toJSON(): SerializedSession {
    return {
      version: 1,
      ...(this.systemPrompt !== undefined && { systemPrompt: this.systemPrompt }),
      messages: [...this._messages],
      ...(this.metadata !== undefined && { metadata: this.metadata }),
      ...(this.tokenBudget !== undefined && { tokenBudget: this.tokenBudget }),
    }
  }

  static fromJSON(json: SerializedSession, dispatch: InferDispatch): AgentSession {
    if (json.version !== 1) {
      throw new BackendSessionError(`unsupported SerializedSession version: ${json.version}`)
    }
    return new AgentSession(dispatch, {
      ...(json.systemPrompt !== undefined && { systemPrompt: json.systemPrompt }),
      messages: json.messages,
      ...(json.metadata !== undefined && { metadata: json.metadata }),
      ...(json.tokenBudget !== undefined && { tokenBudget: json.tokenBudget }),
    })
  }
}

export type { MessageRole, SessionMessage, SessionToolCall }
