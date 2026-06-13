/**
 * Conversation adapter contract — the normalized surface every chat/messaging
 * integration (Discord, Matrix, Slack, Telegram, …) implements.
 *
 * Derived from the OpenClaw/Hermes platform-adapter surfaces but skelm-native:
 * a small set of REQUIRED normalized operations every provider must support,
 * plus OPTIONAL capability operations a provider advertises through its
 * {@link CapabilityDescriptor}. Provider-specific behavior lives behind the
 * optional ops and the descriptor's `escapeHatches`; the gateway and dashboard
 * read the descriptor to validate workflows and render setup UI.
 */

import type { Connection } from './credentials.js'

/** Normalized media kinds an adapter may send or receive. */
export type MediaKind = 'image' | 'file' | 'voice' | 'audio' | 'video' | 'animation' | 'sticker'

/**
 * A normalized media attachment. Binary payloads are referenced, never inlined
 * as resolved secrets; large payloads should be carried as an artifact ref or a
 * provider URL rather than base64 where practical.
 */
export interface MediaAttachment {
  readonly kind: MediaKind
  readonly contentType: string
  /** Suggested filename, when known. */
  readonly filename?: string
  /** Provider or artifact URL for the payload, when not inlined. */
  readonly url?: string
  /** Inline base64 payload, when small enough to carry directly. */
  readonly data?: string
  /** Size in bytes, when known. */
  readonly size?: number
}

/** Normalized identity of who/where an event originated or is destined. */
export interface ConversationTarget {
  /** Channel/room/chat id in the provider's namespace. */
  readonly conversationId: string
  /** Thread/topic id within the conversation, when threading applies. */
  readonly threadId?: string
  /** Originating user id, for inbound events. */
  readonly userId?: string
}

/** A normalized inbound event produced by an adapter from a provider event. */
export interface InboundEvent {
  readonly provider: string
  /** Stable provider event id, for dedupe/idempotency. */
  readonly eventId: string
  readonly type: 'message' | 'edit' | 'delete' | 'reaction' | 'callback' | 'command'
  readonly target: ConversationTarget
  /** Provider message id this event concerns, when applicable. */
  readonly messageId?: string
  readonly text?: string
  readonly attachments?: readonly MediaAttachment[]
  /** Reaction emoji/key for `reaction` events. */
  readonly reaction?: string
  /** Slash command name (without leading `/`) for `command` events. */
  readonly command?: string
  /** Button/callback payload id for `callback` events. */
  readonly callbackId?: string
  /** Epoch milliseconds the provider reported for the event. */
  readonly at: number
  /** Provider-specific raw fields, opaque to the normalized layer. */
  readonly raw?: Readonly<Record<string, unknown>>
}

/** A normalized outbound message an adapter sends. */
export interface OutboundEvent {
  readonly target: ConversationTarget
  readonly text?: string
  readonly attachments?: readonly MediaAttachment[]
  /** Provider message id to edit/reply-to, when the op needs one. */
  readonly replyToMessageId?: string
  /** Provider-specific escape-hatch payload (Block Kit, inline keyboards, …). */
  readonly providerOptions?: Readonly<Record<string, unknown>>
}

/** Result of a send/edit op: the provider message id and conversation. */
export interface SentMessageRef {
  readonly messageId: string
  readonly target: ConversationTarget
}

/** Non-secret descriptive info about a conversation target. */
export interface ConversationTargetInfo {
  readonly target: ConversationTarget
  readonly title?: string
  readonly kind?: 'dm' | 'group' | 'channel' | 'thread'
  readonly memberCount?: number
}

/**
 * Which optional capability operations a provider supports. Required ops
 * (`connect`, `disconnect`, `sendMessage`, `sendTyping`, `getTargetInfo`,
 * inbound subscription) are not listed — every adapter has them. The dashboard
 * and workflow validator read this to disable unsupported operations and render
 * a capability matrix.
 */
export interface CapabilityDescriptor {
  readonly provider: string
  readonly editMessage: boolean
  readonly deleteMessage: boolean
  readonly replyInThread: boolean
  readonly reactions: boolean
  readonly buttons: boolean
  readonly slashCommands: boolean
  /** Media kinds the provider can send. Empty when none. */
  readonly media: readonly MediaKind[]
  /** Maximum outbound message length in characters, when the provider caps it. */
  readonly maxMessageLength?: number
  /** Provider-specific feature names surfaced for documentation/UX only. */
  readonly escapeHatches?: readonly string[]
}

/** Unsubscribe handle returned by {@link ConversationAdapter.onInbound}. */
export type Unsubscribe = () => void

/**
 * The conversation adapter contract. Required ops are always present; optional
 * ops are present only when the matching {@link CapabilityDescriptor} flag is
 * true. An adapter never resolves its own secrets — the gateway resolves the
 * {@link Connection}'s credential references and supplies an ephemeral
 * authenticated transport.
 */
export interface ConversationAdapter {
  readonly provider: string
  readonly capabilities: CapabilityDescriptor

  // --- Required normalized operations ---
  connect(connection: Connection): Promise<void>
  disconnect(): Promise<void>
  sendMessage(event: OutboundEvent): Promise<SentMessageRef>
  sendTyping(target: ConversationTarget): Promise<void>
  getTargetInfo(target: ConversationTarget): Promise<ConversationTargetInfo>
  /** Subscribe to normalized inbound events; returns an unsubscribe function. */
  onInbound(handler: (event: InboundEvent) => void): Unsubscribe

  // --- Optional capability operations (present iff descriptor flag is set) ---
  editMessage?(ref: SentMessageRef, event: OutboundEvent): Promise<SentMessageRef>
  deleteMessage?(ref: SentMessageRef): Promise<void>
  replyInThread?(parent: SentMessageRef, event: OutboundEvent): Promise<SentMessageRef>
  addReaction?(ref: SentMessageRef, reaction: string): Promise<void>
  removeReaction?(ref: SentMessageRef, reaction: string): Promise<void>
  /** Register slash/command definitions with the provider, when supported. */
  registerCommands?(commands: readonly string[]): Promise<void>
  sendImage?(target: ConversationTarget, image: MediaAttachment): Promise<SentMessageRef>
  sendFile?(target: ConversationTarget, file: MediaAttachment): Promise<SentMessageRef>
  sendVoice?(target: ConversationTarget, voice: MediaAttachment): Promise<SentMessageRef>
  sendVideo?(target: ConversationTarget, video: MediaAttachment): Promise<SentMessageRef>
}

/** Type guard for a well-formed {@link CapabilityDescriptor}. */
export function isCapabilityDescriptor(value: unknown): value is CapabilityDescriptor {
  if (typeof value !== 'object' || value === null) return false
  const d = value as Record<string, unknown>
  return (
    typeof d.provider === 'string' &&
    typeof d.editMessage === 'boolean' &&
    typeof d.deleteMessage === 'boolean' &&
    typeof d.replyInThread === 'boolean' &&
    typeof d.reactions === 'boolean' &&
    typeof d.buttons === 'boolean' &&
    typeof d.slashCommands === 'boolean' &&
    Array.isArray(d.media)
  )
}
