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
 * Authenticated Matrix Client-Server API transport. The gateway resolves the
 * connection's credential references and supplies a transport bound to an
 * ephemeral access token and homeserver base url; the adapter passes a method,
 * a `/_matrix/client/v3`-relative path, and a body, and never sees the token.
 */
export type MatrixTransport = (
  method: string,
  path: string,
  body?: Readonly<Record<string, unknown>>,
) => Promise<Record<string, unknown>>

const MATRIX_CAPABILITIES: CapabilityDescriptor = {
  provider: 'matrix',
  editMessage: true,
  deleteMessage: true,
  replyInThread: true,
  reactions: true,
  // Matrix has no slash-command registration API; commands are client-side.
  buttons: false,
  slashCommands: false,
  media: ['image', 'file', 'video'],
  mediaSources: ['url'],
  escapeHatches: ['customEventContent', 'mInReplyTo', 'mThread'],
}

let txnCounter = 0
function nextTxnId(): string {
  return `skelm${Date.now()}.${txnCounter++}`
}

/**
 * Matrix {@link ConversationAdapter}. Exposes the Matrix Client-Server API
 * behind the normalized conversation surface without replacing the existing
 * {@link MatrixIntegration} export. Edits, reactions, threads and attachments
 * map onto Matrix `m.relates_to` relations; arbitrary event content rides the
 * `providerOptions` escape hatch.
 *
 * Credentials stay references only: the gateway-supplied {@link MatrixTransport}
 * owns the resolved token and base url.
 */
export class MatrixConversationAdapter implements ConversationAdapter {
  readonly provider = 'matrix' as const
  readonly capabilities = MATRIX_CAPABILITIES

  private readonly transport: MatrixTransport
  private connection: Connection | null = null
  private readonly handlers = new Set<(event: InboundEvent) => void>()

  constructor(transport: MatrixTransport) {
    this.transport = transport
  }

  async connect(connection: Connection): Promise<void> {
    assertNoSecretValue(connection, 'Matrix connection')
    for (const ref of connection.credentials) {
      assertNoSecretValue(ref, 'Matrix credential reference')
    }
    this.connection = connection
  }

  async disconnect(): Promise<void> {
    this.connection = null
    this.handlers.clear()
  }

  async sendMessage(event: OutboundEvent): Promise<SentMessageRef> {
    const content: Record<string, unknown> = { msgtype: 'm.text', body: event.text ?? '' }
    if (event.target.threadId !== undefined) {
      content['m.relates_to'] = { rel_type: 'm.thread', event_id: event.target.threadId }
    }
    if (event.providerOptions !== undefined) Object.assign(content, event.providerOptions)
    return this.sendEvent(event.target, content)
  }

  async sendTyping(target: ConversationTarget): Promise<void> {
    const userPath = userIdPathSegment(this.connection)
    await this.transport(
      'PUT',
      `/rooms/${encodeURIComponent(target.conversationId)}/typing/${userPath}`,
      { typing: true, timeout: 20000 },
    )
  }

  async getTargetInfo(target: ConversationTarget): Promise<ConversationTargetInfo> {
    const res = await this.transport(
      'GET',
      `/rooms/${encodeURIComponent(target.conversationId)}/state/m.room.name/`,
    )
    const name = (res as { name?: string }).name
    return {
      target,
      ...(name !== undefined && { title: name }),
      kind: target.threadId !== undefined ? 'thread' : 'channel',
    }
  }

  onInbound(handler: (event: InboundEvent) => void): Unsubscribe {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  async editMessage(ref: SentMessageRef, event: OutboundEvent): Promise<SentMessageRef> {
    const newBody = event.text ?? ''
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body: `* ${newBody}`,
      'm.new_content': { msgtype: 'm.text', body: newBody },
      'm.relates_to': { rel_type: 'm.replace', event_id: ref.messageId },
    }
    if (event.providerOptions !== undefined) Object.assign(content, event.providerOptions)
    return this.sendEvent(ref.target, content)
  }

  async deleteMessage(ref: SentMessageRef): Promise<void> {
    const txn = nextTxnId()
    await this.transport(
      'PUT',
      `/rooms/${encodeURIComponent(ref.target.conversationId)}/redact/${encodeURIComponent(ref.messageId)}/${encodeURIComponent(txn)}`,
      {},
    )
  }

  async replyInThread(parent: SentMessageRef, event: OutboundEvent): Promise<SentMessageRef> {
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body: event.text ?? '',
      'm.relates_to': { rel_type: 'm.thread', event_id: parent.messageId },
    }
    if (event.providerOptions !== undefined) Object.assign(content, event.providerOptions)
    return this.sendEvent(parent.target, content)
  }

  async addReaction(ref: SentMessageRef, reaction: string): Promise<void> {
    const txn = nextTxnId()
    await this.transport(
      'PUT',
      `/rooms/${encodeURIComponent(ref.target.conversationId)}/send/m.reaction/${encodeURIComponent(txn)}`,
      { 'm.relates_to': { rel_type: 'm.annotation', event_id: ref.messageId, key: reaction } },
    )
  }

  async sendImage(target: ConversationTarget, image: MediaAttachment): Promise<SentMessageRef> {
    return this.sendMedia(target, image, 'm.image')
  }

  async sendFile(target: ConversationTarget, file: MediaAttachment): Promise<SentMessageRef> {
    return this.sendMedia(target, file, 'm.file')
  }

  async sendVideo(target: ConversationTarget, video: MediaAttachment): Promise<SentMessageRef> {
    return this.sendMedia(target, video, 'm.video')
  }

  /**
   * Normalize a single raw Matrix timeline event into an {@link InboundEvent}
   * and dispatch it to subscribers.
   */
  ingest(event: unknown): InboundEvent | null {
    const normalized = normalizeMatrixInbound(event)
    if (normalized === null) return null
    for (const handler of this.handlers) handler(normalized)
    return normalized
  }

  private async sendMedia(
    target: ConversationTarget,
    media: MediaAttachment,
    msgtype: string,
  ): Promise<SentMessageRef> {
    const content: Record<string, unknown> = {
      msgtype,
      body: media.filename ?? msgtype,
      url: requireHostedMediaUrl(media),
      info: { mimetype: media.contentType, ...(media.size !== undefined && { size: media.size }) },
    }
    if (target.threadId !== undefined) {
      content['m.relates_to'] = { rel_type: 'm.thread', event_id: target.threadId }
    }
    return this.sendEvent(target, content)
  }

  private async sendEvent(
    target: ConversationTarget,
    content: Readonly<Record<string, unknown>>,
  ): Promise<SentMessageRef> {
    const txn = nextTxnId()
    const res = await this.transport(
      'PUT',
      `/rooms/${encodeURIComponent(target.conversationId)}/send/m.room.message/${encodeURIComponent(txn)}`,
      content,
    )
    const eventId = (res as { event_id?: string }).event_id
    if (typeof eventId !== 'string') {
      throw new IntegrationApiError('Matrix send returned no event id', 'matrix')
    }
    return { messageId: eventId, target }
  }
}

function requireHostedMediaUrl(media: MediaAttachment): string {
  if (media.url !== undefined) return media.url
  throw new IntegrationApiError(
    'Matrix media sends require MediaAttachment.url; inline MediaAttachment.data is not supported',
    'matrix',
  )
}

function userIdPathSegment(connection: Connection | null): string {
  const userId = connection?.metadata?.userId
  return encodeURIComponent(typeof userId === 'string' ? userId : '@bot:localhost')
}

interface RawMatrixEvent {
  type?: string
  event_id?: string
  room_id?: string
  sender?: string
  origin_server_ts?: number
  content?: {
    msgtype?: string
    body?: string
    'm.relates_to'?: {
      rel_type?: string
      event_id?: string
      key?: string
      'm.in_reply_to'?: { event_id?: string }
    }
    'm.new_content'?: { body?: string }
  }
  redacts?: string
}

/**
 * Normalize a raw Matrix timeline event (carrying `room_id`) into an
 * {@link InboundEvent}. Handles `m.text` messages, `m.replace` edits,
 * `m.reaction` annotations, `m.thread` replies, and `m.room.redaction`
 * deletions. Returns null for unsupported event types.
 */
export function normalizeMatrixInbound(event: unknown): InboundEvent | null {
  if (typeof event !== 'object' || event === null) return null
  const e = event as RawMatrixEvent
  if (typeof e.event_id !== 'string' || typeof e.room_id !== 'string') return null
  const at = e.origin_server_ts ?? Date.now()
  const raw = event as Readonly<Record<string, unknown>>

  if (e.type === 'm.reaction') {
    const rel = e.content?.['m.relates_to']
    return {
      provider: 'matrix',
      eventId: e.event_id,
      type: 'reaction',
      target: target(e.room_id, undefined, e.sender),
      ...(rel?.event_id !== undefined && { messageId: rel.event_id }),
      ...(rel?.key !== undefined && { reaction: rel.key }),
      at,
      raw,
    }
  }

  if (e.type === 'm.room.redaction') {
    return {
      provider: 'matrix',
      eventId: e.event_id,
      type: 'delete',
      target: target(e.room_id, undefined, e.sender),
      ...(e.redacts !== undefined && { messageId: e.redacts }),
      at,
      raw,
    }
  }

  if (e.type === 'm.room.message' && e.content?.msgtype === 'm.text') {
    const rel = e.content['m.relates_to']
    if (rel?.rel_type === 'm.replace') {
      const newBody = e.content['m.new_content']?.body
      return {
        provider: 'matrix',
        eventId: e.event_id,
        type: 'edit',
        target: target(e.room_id, undefined, e.sender),
        ...(rel.event_id !== undefined && { messageId: rel.event_id }),
        ...(typeof newBody === 'string' && { text: newBody }),
        at,
        raw,
      }
    }
    const threadId = rel?.rel_type === 'm.thread' ? rel.event_id : undefined
    return {
      provider: 'matrix',
      eventId: e.event_id,
      type: 'message',
      target: target(e.room_id, threadId, e.sender),
      messageId: e.event_id,
      ...(typeof e.content.body === 'string' && { text: e.content.body }),
      at,
      raw,
    }
  }

  return null
}

function target(conversationId: string, threadId?: string, userId?: string): ConversationTarget {
  return {
    conversationId,
    ...(threadId !== undefined && { threadId }),
    ...(userId !== undefined && { userId }),
  }
}
