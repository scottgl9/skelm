import {
  type CapabilityDescriptor,
  type Connection,
  type ConversationAdapter,
  type ConversationTarget,
  type ConversationTargetInfo,
  type InboundEvent,
  type MediaAttachment,
  type OutboundEvent,
  type SentMessageRef,
  type Unsubscribe,
  assertNoSecretValue,
} from '@skelm/integration-sdk'
import { IntegrationApiError } from './errors.js'

/**
 * Authenticated Telegram Bot API transport. The gateway resolves the
 * connection's credential references and supplies a transport bound to an
 * ephemeral bot token; the adapter calls `method` (e.g. `sendMessage`) with a
 * body and never sees the token. Injected so tests drive deterministic payloads.
 */
export type TelegramTransport = (
  method: string,
  body: Readonly<Record<string, unknown>>,
) => Promise<Record<string, unknown>>

const TELEGRAM_CAPABILITIES: CapabilityDescriptor = {
  provider: 'telegram',
  editMessage: true,
  deleteMessage: true,
  // Telegram threads exist only as forum topics / reply chains; modeled via the
  // reply-to escape hatch rather than a first-class thread op.
  replyInThread: false,
  reactions: true,
  buttons: true,
  slashCommands: true,
  media: ['image', 'file', 'voice', 'video'],
  mediaSources: ['url'],
  maxMessageLength: 4096,
  escapeHatches: ['inlineKeyboards', 'callbackQueries', 'parseMode'],
}

function chatIdOf(target: ConversationTarget): string {
  return target.conversationId
}

/** Map a normalized outbound event to a `sendMessage` body. */
function toSendBody(event: OutboundEvent): Record<string, unknown> {
  const body: Record<string, unknown> = { chat_id: chatIdOf(event.target) }
  if (event.text !== undefined) body.text = event.text
  if (event.replyToMessageId !== undefined) {
    body.reply_to_message_id = Number(event.replyToMessageId)
  }
  // Inline keyboards, parse_mode, etc. ride the escape hatch verbatim.
  if (event.providerOptions !== undefined) Object.assign(body, event.providerOptions)
  return body
}

/**
 * Telegram {@link ConversationAdapter}. Exposes the Telegram Bot API behind the
 * normalized conversation surface without replacing the existing
 * {@link TelegramIntegration} export. Inline keyboards, callback queries,
 * message edits and media rides through the optional capability ops and the
 * `providerOptions` escape hatch.
 *
 * Credentials stay references only: the gateway-supplied {@link TelegramTransport}
 * owns the resolved token; {@link connect} only validates the {@link Connection}
 * carries no secret value.
 */
export class TelegramConversationAdapter implements ConversationAdapter {
  readonly provider = 'telegram' as const
  readonly capabilities = TELEGRAM_CAPABILITIES

  private readonly transport: TelegramTransport
  private connection: Connection | null = null
  private readonly handlers = new Set<(event: InboundEvent) => void>()

  constructor(transport: TelegramTransport) {
    this.transport = transport
  }

  async connect(connection: Connection): Promise<void> {
    assertNoSecretValue(connection, 'Telegram connection')
    for (const ref of connection.credentials) {
      assertNoSecretValue(ref, 'Telegram credential reference')
    }
    this.connection = connection
  }

  async disconnect(): Promise<void> {
    this.connection = null
    this.handlers.clear()
  }

  async sendMessage(event: OutboundEvent): Promise<SentMessageRef> {
    return this.send('sendMessage', toSendBody(event), event.target)
  }

  async sendTyping(target: ConversationTarget): Promise<void> {
    await this.transport('sendChatAction', { chat_id: chatIdOf(target), action: 'typing' })
  }

  async getTargetInfo(target: ConversationTarget): Promise<ConversationTargetInfo> {
    const res = await this.transport('getChat', { chat_id: chatIdOf(target) })
    const chat = res as { type?: string; title?: string; username?: string }
    const kind = chat.type === 'private' ? 'dm' : chat.type === 'channel' ? 'channel' : 'group'
    return {
      target,
      ...(chat.title !== undefined && { title: chat.title }),
      kind,
    }
  }

  onInbound(handler: (event: InboundEvent) => void): Unsubscribe {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  async editMessage(ref: SentMessageRef, event: OutboundEvent): Promise<SentMessageRef> {
    const body: Record<string, unknown> = {
      chat_id: ref.target.conversationId,
      message_id: Number(ref.messageId),
    }
    if (event.text !== undefined) body.text = event.text
    if (event.providerOptions !== undefined) Object.assign(body, event.providerOptions)
    await this.transport('editMessageText', body)
    return ref
  }

  async deleteMessage(ref: SentMessageRef): Promise<void> {
    await this.transport('deleteMessage', {
      chat_id: ref.target.conversationId,
      message_id: Number(ref.messageId),
    })
  }

  async addReaction(ref: SentMessageRef, reaction: string): Promise<void> {
    await this.transport('setMessageReaction', {
      chat_id: ref.target.conversationId,
      message_id: Number(ref.messageId),
      reaction: [{ type: 'emoji', emoji: reaction }],
    })
  }

  async removeReaction(ref: SentMessageRef, _reaction: string): Promise<void> {
    await this.transport('setMessageReaction', {
      chat_id: ref.target.conversationId,
      message_id: Number(ref.messageId),
      reaction: [],
    })
  }

  async sendImage(target: ConversationTarget, image: MediaAttachment): Promise<SentMessageRef> {
    return this.sendMedia('sendPhoto', 'photo', target, image)
  }

  async sendFile(target: ConversationTarget, file: MediaAttachment): Promise<SentMessageRef> {
    return this.sendMedia('sendDocument', 'document', target, file)
  }

  async sendVoice(target: ConversationTarget, voice: MediaAttachment): Promise<SentMessageRef> {
    return this.sendMedia('sendVoice', 'voice', target, voice)
  }

  async sendVideo(target: ConversationTarget, video: MediaAttachment): Promise<SentMessageRef> {
    return this.sendMedia('sendVideo', 'video', target, video)
  }

  /**
   * Normalize a verified Telegram update into an {@link InboundEvent} and
   * dispatch it to subscribers. Webhook secret verification is the caller's job
   * (see `TelegramIntegration.verifyWebhookSecret`) and must run before this.
   */
  ingest(update: unknown): InboundEvent | null {
    const event = normalizeTelegramInbound(update)
    if (event === null) return null
    for (const handler of this.handlers) handler(event)
    return event
  }

  private async sendMedia(
    method: string,
    field: string,
    target: ConversationTarget,
    media: MediaAttachment,
  ): Promise<SentMessageRef> {
    const body: Record<string, unknown> = {
      chat_id: chatIdOf(target),
      [field]: requireHostedMediaUrl(media),
    }
    if (media.filename !== undefined && field === 'document') body.filename = media.filename
    if (target.threadId !== undefined) body.message_thread_id = Number(target.threadId)
    return this.send(method, body, target)
  }

  private async send(
    method: string,
    body: Readonly<Record<string, unknown>>,
    target: ConversationTarget,
  ): Promise<SentMessageRef> {
    const res = await this.transport(method, body)
    const messageId = res.message_id
    if (typeof messageId !== 'number') {
      throw new IntegrationApiError(`Telegram ${method} returned no message id`, 'telegram')
    }
    return {
      messageId: String(messageId),
      target: { ...target, conversationId: chatIdOf(target) },
    }
  }
}

function requireHostedMediaUrl(media: MediaAttachment): string {
  if (media.url !== undefined) return media.url
  throw new IntegrationApiError(
    'Telegram media sends require MediaAttachment.url; inline MediaAttachment.data is not supported',
    'telegram',
  )
}

interface RawTelegramMessage {
  message_id?: number
  chat?: { id?: number | string }
  from?: { id?: number; username?: string; first_name?: string }
  date?: number
  text?: string
  message_thread_id?: number
}

/**
 * Normalize a raw Telegram update into an {@link InboundEvent}. Handles plain
 * messages, edited messages (`edit`), callback queries (`callback`), reactions
 * (`message_reaction`), and slash commands detected from a leading `/` with a
 * `bot_command` entity. Returns null for updates with no normalized form.
 */
export function normalizeTelegramInbound(update: unknown): InboundEvent | null {
  const u = update as Record<string, unknown>

  if (u.callback_query !== undefined) {
    const cq = u.callback_query as {
      id?: string
      from?: { id?: number }
      data?: string
      message?: RawTelegramMessage
    }
    const chatId = cq.message?.chat?.id
    return {
      provider: 'telegram',
      eventId: String(cq.id ?? `${chatId ?? ''}:${Date.now()}`),
      type: 'callback',
      target: target(String(chatId ?? ''), cq.message?.message_thread_id, cq.from?.id),
      ...(cq.message?.message_id !== undefined && { messageId: String(cq.message.message_id) }),
      ...(typeof cq.data === 'string' && { callbackId: cq.data }),
      at: Date.now(),
      raw: u,
    }
  }

  if (u.message_reaction !== undefined) {
    const mr = u.message_reaction as {
      chat?: { id?: number | string }
      message_id?: number
      user?: { id?: number }
      new_reaction?: Array<{ emoji?: string }>
      date?: number
    }
    const emoji = mr.new_reaction?.[0]?.emoji
    return {
      provider: 'telegram',
      eventId: `${mr.chat?.id ?? ''}:${mr.message_id ?? ''}:reaction`,
      type: 'reaction',
      target: target(String(mr.chat?.id ?? ''), undefined, mr.user?.id),
      ...(mr.message_id !== undefined && { messageId: String(mr.message_id) }),
      ...(emoji !== undefined && { reaction: emoji }),
      at: secondsToMs(mr.date) ?? Date.now(),
      raw: u,
    }
  }

  const edited = u.edited_message as (RawTelegramMessage & { entities?: unknown }) | undefined
  const message = u.message as
    | (RawTelegramMessage & { entities?: Array<{ type?: string; offset?: number }> })
    | undefined
  const msg = edited ?? message
  if (msg === undefined || typeof msg.message_id !== 'number') return null

  const base = {
    provider: 'telegram' as const,
    eventId: `${msg.chat?.id ?? ''}:${msg.message_id}${edited !== undefined ? ':edit' : ''}`,
    target: target(String(msg.chat?.id ?? ''), msg.message_thread_id, msg.from?.id),
    messageId: String(msg.message_id),
    ...(typeof msg.text === 'string' && { text: msg.text }),
    at: secondsToMs(msg.date) ?? Date.now(),
    raw: u,
  }

  if (edited !== undefined) return { ...base, type: 'edit' }

  const entities = message?.entities ?? []
  const isCommand =
    typeof msg.text === 'string' &&
    msg.text.startsWith('/') &&
    entities.some((e) => e.type === 'bot_command' && (e.offset ?? 0) === 0)
  if (isCommand && typeof msg.text === 'string') {
    const command = msg.text.slice(1).split(/[\s@]/)[0]
    return { ...base, type: 'command', command }
  }

  return { ...base, type: 'message' }
}

function target(conversationId: string, threadId?: number, userId?: number): ConversationTarget {
  return {
    conversationId,
    ...(threadId !== undefined && { threadId: String(threadId) }),
    ...(userId !== undefined && { userId: String(userId) }),
  }
}

function secondsToMs(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v * 1000 : undefined
}
