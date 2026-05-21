/**
 * Wire-format-neutral message shape used inside an AgentSession.
 *
 * Designed to serialize cleanly through skelm's run store: every field is
 * either a primitive, a plain object, or `undefined`. No Dates, no Maps, no
 * class instances.
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface SessionToolCall {
  id: string
  name: string
  /** JSON-encoded arguments string, as emitted by the chat-completions API. */
  arguments: string
}

export interface SessionMessage {
  role: MessageRole
  /** Plain text content. Empty string when the message is purely tool calls. */
  content: string
  /** Present on assistant messages that decided to call one or more tools. */
  toolCalls?: readonly SessionToolCall[]
  /** Present on `role: 'tool'` messages. References the assistant's tool call id. */
  toolCallId?: string
  /** Optional usage stats attached to assistant messages. */
  usage?: { inputTokens: number; outputTokens: number }
}
