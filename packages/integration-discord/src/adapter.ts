/**
 * Discord {@link ConversationAdapter} implementation.
 *
 * The adapter implements the required normalized ops plus the optional
 * capability ops Discord supports (edit/delete, threads, reactions,
 * components). Provider-specific
 * features (embeds, button rows) are reachable via `OutboundEvent.providerOptions`
 * and listed in the descriptor's `escapeHatches`.
 *
 * SECURITY: the adapter never resolves a credential reference and never reads
 * `process.env`. The gateway resolves the {@link Connection}'s bot-token
 * reference and supplies the ephemeral value through `tokenResolver` at
 * `connect`. The adapter passes that value only as an `Authorization` header
 * inside {@link DiscordRestClient}; it is never logged, returned, or persisted.
 */

import {
  type CapabilityDescriptor,
  type Connection,
  type ConversationAdapter,
  type ConversationTarget,
  type ConversationTargetInfo,
  type EgressPolicy,
  type InboundEvent,
  IntegrationUnsupportedOperationError,
  type OutboundEvent,
  type SentMessageRef,
  type Unsubscribe,
} from '@skelm/integration-sdk'
import { DiscordNotConnectedError } from './errors.js'
import { DiscordRestClient } from './rest.js'
import { DISCORD_PROVIDER } from './types.js'
import type { DiscordChannel, DiscordMessage } from './types.js'

/** Resolves a connection's bot token to an ephemeral value. Gateway-owned. */
export type DiscordTokenResolver = (connection: Connection) => Promise<string>

export interface DiscordAdapterOptions {
  /** Egress policy the gateway supplies; the REST client refuses denied hosts. */
  readonly egress: EgressPolicy
  /**
   * Resolves the connection's bot-token reference to an ephemeral value. The
   * gateway owns secret resolution; the adapter never reads it itself.
   */
  readonly tokenResolver: DiscordTokenResolver
  /** Injected fetch for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/** Discord's outbound message length cap. */
const DISCORD_MAX_MESSAGE_LENGTH = 2000

export const DISCORD_CAPABILITIES: CapabilityDescriptor = {
  provider: DISCORD_PROVIDER,
  editMessage: true,
  deleteMessage: true,
  replyInThread: true,
  reactions: true,
  buttons: true,
  slashCommands: false,
  media: [],
  maxMessageLength: DISCORD_MAX_MESSAGE_LENGTH,
  escapeHatches: ['embeds', 'components', 'allowed_mentions'],
}

export class DiscordAdapter implements ConversationAdapter {
  readonly provider = DISCORD_PROVIDER
  readonly capabilities = DISCORD_CAPABILITIES

  private readonly egress: EgressPolicy
  private readonly tokenResolver: DiscordTokenResolver
  private readonly fetchImpl: typeof fetch | undefined
  private rest: DiscordRestClient | null = null
  private readonly inboundHandlers = new Set<(event: InboundEvent) => void>()

  constructor(opts: DiscordAdapterOptions) {
    this.egress = opts.egress
    this.tokenResolver = opts.tokenResolver
    this.fetchImpl = opts.fetchImpl
  }

  async connect(_connection: Connection): Promise<void> {
    const botToken = await this.tokenResolver(_connection)
    this.rest = new DiscordRestClient({
      botToken,
      egress: this.egress,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    })
  }

  async disconnect(): Promise<void> {
    this.rest = null
    this.inboundHandlers.clear()
  }

  /**
   * Feed a normalized inbound event to subscribers. The gateway calls this
   * after verifying and normalizing a raw Discord dispatch/interaction.
   */
  emitInbound(event: InboundEvent): void {
    for (const handler of this.inboundHandlers) handler(event)
  }

  onInbound(handler: (event: InboundEvent) => void): Unsubscribe {
    this.inboundHandlers.add(handler)
    return () => {
      this.inboundHandlers.delete(handler)
    }
  }

  async sendMessage(event: OutboundEvent): Promise<SentMessageRef> {
    const body = this.outboundBody(event)
    const message = await this.client().request<DiscordMessage>(
      'POST',
      `/channels/${event.target.threadId ?? event.target.conversationId}/messages`,
      body,
    )
    return this.toSentRef(message, event.target)
  }

  async sendTyping(target: ConversationTarget): Promise<void> {
    await this.client().request<void>(
      'POST',
      `/channels/${target.threadId ?? target.conversationId}/typing`,
    )
  }

  async getTargetInfo(target: ConversationTarget): Promise<ConversationTargetInfo> {
    const channel = await this.client().request<DiscordChannel>(
      'GET',
      `/channels/${target.threadId ?? target.conversationId}`,
    )
    return {
      target,
      ...(channel.name !== undefined ? { title: channel.name } : {}),
      kind: channelKind(channel.type),
      ...(channel.member_count !== undefined ? { memberCount: channel.member_count } : {}),
    }
  }

  async editMessage(ref: SentMessageRef, event: OutboundEvent): Promise<SentMessageRef> {
    const message = await this.client().request<DiscordMessage>(
      'PATCH',
      `/channels/${ref.target.threadId ?? ref.target.conversationId}/messages/${ref.messageId}`,
      this.outboundBody(event),
    )
    return this.toSentRef(message, ref.target)
  }

  async deleteMessage(ref: SentMessageRef): Promise<void> {
    await this.client().request<void>(
      'DELETE',
      `/channels/${ref.target.threadId ?? ref.target.conversationId}/messages/${ref.messageId}`,
    )
  }

  async replyInThread(parent: SentMessageRef, event: OutboundEvent): Promise<SentMessageRef> {
    const thread = await this.client().request<DiscordChannel>(
      'POST',
      `/channels/${parent.target.conversationId}/messages/${parent.messageId}/threads`,
      { name: threadName(event.text) },
    )
    return this.sendMessage({
      ...event,
      target: { conversationId: parent.target.conversationId, threadId: thread.id },
    })
  }

  async addReaction(ref: SentMessageRef, reaction: string): Promise<void> {
    await this.client().request<void>(
      'PUT',
      `/channels/${ref.target.threadId ?? ref.target.conversationId}/messages/${ref.messageId}/reactions/${encodeURIComponent(reaction)}/@me`,
    )
  }

  async removeReaction(ref: SentMessageRef, reaction: string): Promise<void> {
    await this.client().request<void>(
      'DELETE',
      `/channels/${ref.target.threadId ?? ref.target.conversationId}/messages/${ref.messageId}/reactions/${encodeURIComponent(reaction)}/@me`,
    )
  }

  private outboundBody(event: OutboundEvent): Record<string, unknown> {
    const body: Record<string, unknown> = {}
    if (event.text !== undefined) body.content = event.text
    if (event.replyToMessageId !== undefined) {
      body.message_reference = { message_id: event.replyToMessageId }
    }
    if (event.attachments !== undefined && event.attachments.length > 0) {
      throw new IntegrationUnsupportedOperationError(
        'Discord outbound media upload is not supported; send hosted media via providerOptions instead',
      )
    }
    if (event.providerOptions !== undefined) {
      Object.assign(body, event.providerOptions)
    }
    return body
  }

  private toSentRef(message: DiscordMessage, target: ConversationTarget): SentMessageRef {
    return {
      messageId: message.id,
      target: { ...target, conversationId: message.channel_id || target.conversationId },
    }
  }

  private client(): DiscordRestClient {
    if (this.rest === null) {
      throw new DiscordNotConnectedError('Discord adapter not connected — call connect() first')
    }
    return this.rest
  }
}

function channelKind(type: number | undefined): 'dm' | 'group' | 'channel' | 'thread' {
  switch (type) {
    case 1:
      return 'dm'
    case 3:
      return 'group'
    case 10:
    case 11:
    case 12:
      return 'thread'
    default:
      return 'channel'
  }
}

function threadName(text: string | undefined): string {
  const base = (text ?? 'thread').trim().slice(0, 90)
  return base.length > 0 ? base : 'thread'
}
