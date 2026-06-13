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
import { IntegrationConfigError } from './errors.js'
import { verifySlackSignature } from './slack.js'

/**
 * Result of one Slack Web API call, as the adapter needs it. The transport
 * resolves the call against an authenticated Slack client the gateway supplies;
 * the adapter never reads a token itself.
 */
export interface SlackTransportResult {
  readonly ok: boolean
  /** Channel the message landed in (`channel` in Slack responses). */
  readonly channel?: string
  /** Message timestamp id (`ts`) — Slack's per-channel message id. */
  readonly ts?: string
  readonly error?: string
}

/**
 * Authenticated Slack Web API transport. The gateway resolves the connection's
 * credential references and supplies a transport bound to an ephemeral bot
 * token; the adapter calls `method` (e.g. `chat.postMessage`) with a body and
 * never sees the token. Injected so tests drive deterministic payloads.
 */
export type SlackTransport = (
  method: string,
  body: Readonly<Record<string, unknown>>,
) => Promise<SlackTransportResult>

const SLACK_CAPABILITIES: CapabilityDescriptor = {
  provider: 'slack',
  editMessage: true,
  deleteMessage: true,
  replyInThread: true,
  reactions: true,
  buttons: true,
  slashCommands: true,
  media: ['image', 'file'],
  mediaSources: ['url'],
  maxMessageLength: 40000,
  escapeHatches: ['blockKit', 'modals', 'appMentions'],
}

/** Map a normalized outbound event to a `chat.postMessage` body. */
function toPostBody(event: OutboundEvent): Record<string, unknown> {
  const body: Record<string, unknown> = { channel: event.target.conversationId }
  if (event.text !== undefined) body.text = event.text
  if (event.target.threadId !== undefined) body.thread_ts = event.target.threadId
  // Block Kit / interactive payloads ride the escape hatch verbatim.
  if (event.providerOptions !== undefined) Object.assign(body, event.providerOptions)
  return body
}

/**
 * Slack {@link ConversationAdapter}. Wraps the Slack Web API behind the
 * normalized conversation surface without replacing the existing
 * {@link SlackIntegration} export. Block Kit, modals, threads, reactions, files
 * and app mentions are exposed through the optional capability ops and the
 * `providerOptions` escape hatch.
 *
 * Credentials stay references only: {@link connect} validates the
 * {@link Connection} carries no secret value and the gateway-supplied
 * {@link SlackTransport} owns the resolved token. Signature verification reuses
 * {@link verifySlackSignature} unchanged.
 */
export class SlackConversationAdapter implements ConversationAdapter {
  readonly provider = 'slack' as const
  readonly capabilities = SLACK_CAPABILITIES

  private readonly transport: SlackTransport
  private connection: Connection | null = null
  private readonly handlers = new Set<(event: InboundEvent) => void>()

  constructor(transport: SlackTransport) {
    this.transport = transport
  }

  async connect(connection: Connection): Promise<void> {
    assertNoSecretValue(connection, 'Slack connection')
    for (const ref of connection.credentials) assertNoSecretValue(ref, 'Slack credential reference')
    this.connection = connection
  }

  async disconnect(): Promise<void> {
    this.connection = null
    this.handlers.clear()
  }

  async sendMessage(event: OutboundEvent): Promise<SentMessageRef> {
    return this.post('chat.postMessage', toPostBody(event))
  }

  async sendTyping(_target: ConversationTarget): Promise<void> {
    // Slack has no first-party typing API for bots; advertised as a no-op.
  }

  async getTargetInfo(target: ConversationTarget): Promise<ConversationTargetInfo> {
    const res = await this.transport('conversations.info', { channel: target.conversationId })
    const info = res as SlackTransportResult & {
      channel?: { name?: string; is_im?: boolean; is_private?: boolean; num_members?: number }
    }
    const ch = info.channel
    return {
      target,
      ...(ch?.name !== undefined && { title: ch.name }),
      kind: ch?.is_im === true ? 'dm' : 'channel',
      ...(typeof ch?.num_members === 'number' && { memberCount: ch.num_members }),
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
      channel: ref.target.conversationId,
      ts: ref.messageId,
    }
    if (event.text !== undefined) body.text = event.text
    if (event.providerOptions !== undefined) Object.assign(body, event.providerOptions)
    return this.post('chat.update', body)
  }

  async deleteMessage(ref: SentMessageRef): Promise<void> {
    await this.call('chat.delete', { channel: ref.target.conversationId, ts: ref.messageId })
  }

  async replyInThread(parent: SentMessageRef, event: OutboundEvent): Promise<SentMessageRef> {
    const body = toPostBody({
      ...event,
      target: { ...event.target, threadId: parent.messageId },
    })
    return this.post('chat.postMessage', body)
  }

  async addReaction(ref: SentMessageRef, reaction: string): Promise<void> {
    await this.call('reactions.add', {
      channel: ref.target.conversationId,
      timestamp: ref.messageId,
      name: reaction,
    })
  }

  async removeReaction(ref: SentMessageRef, reaction: string): Promise<void> {
    await this.call('reactions.remove', {
      channel: ref.target.conversationId,
      timestamp: ref.messageId,
      name: reaction,
    })
  }

  async sendImage(target: ConversationTarget, image: MediaAttachment): Promise<SentMessageRef> {
    return this.sendFile(target, image)
  }

  async sendFile(target: ConversationTarget, file: MediaAttachment): Promise<SentMessageRef> {
    const body: Record<string, unknown> = { channel_id: target.conversationId }
    body.url = requireHostedMediaUrl(file, 'slack')
    if (file.filename !== undefined) body.filename = file.filename
    if (target.threadId !== undefined) body.thread_ts = target.threadId
    const res = await this.transport('files.upload', body)
    if (!res.ok) throw new IntegrationConfigError(slackError(res, 'files.upload'), 'slack')
    return {
      messageId: res.ts ?? '',
      target: { ...target, conversationId: res.channel ?? target.conversationId },
    }
  }

  /**
   * Normalize a verified Slack webhook payload into an {@link InboundEvent} and
   * dispatch it to subscribers. Signature verification is the caller's job and
   * must run before this — use {@link verifySlackSignature}. Returns the
   * normalized event (or null when the payload carries nothing actionable) so
   * callers can also use the adapter as a pure normalizer.
   */
  ingest(payload: unknown): InboundEvent | null {
    const event = normalizeSlackInbound(payload)
    if (event === null) return null
    for (const handler of this.handlers) handler(event)
    return event
  }

  private async post(
    method: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<SentMessageRef> {
    const res = await this.transport(method, body)
    if (!res.ok || res.ts === undefined) {
      throw new IntegrationConfigError(slackError(res, method), 'slack')
    }
    const conversationId = res.channel ?? String(body.channel ?? '')
    return {
      messageId: res.ts,
      target: {
        conversationId,
        ...(typeof body.thread_ts === 'string' && { threadId: body.thread_ts }),
      },
    }
  }

  private async call(method: string, body: Readonly<Record<string, unknown>>): Promise<void> {
    const res = await this.transport(method, body)
    if (!res.ok) throw new IntegrationConfigError(slackError(res, method), 'slack')
  }
}

function slackError(res: SlackTransportResult, method: string): string {
  return `Slack ${method} failed: ${res.error ?? 'unknown error'}`
}

function requireHostedMediaUrl(media: MediaAttachment, provider: string): string {
  if (media.url !== undefined) return media.url
  throw new IntegrationConfigError(
    `${provider} media sends require MediaAttachment.url; inline MediaAttachment.data is not supported`,
    provider,
  )
}

/**
 * Normalize a Slack Events API / interactive payload into an {@link InboundEvent}.
 * Handles `message`, `app_mention`, `message_changed` (edit), reactions, slash
 * commands, and `block_actions` (button callbacks). Returns null for payloads
 * with no actionable normalized form (e.g. `url_verification`).
 */
export function normalizeSlackInbound(payload: unknown): InboundEvent | null {
  const p = payload as Record<string, unknown>

  // Slash command (application/x-www-form-urlencoded, parsed to an object).
  if (typeof p.command === 'string') {
    return {
      provider: 'slack',
      eventId: String(p.trigger_id ?? `${p.command}:${p.channel_id ?? ''}:${p.user_id ?? ''}`),
      type: 'command',
      target: target(String(p.channel_id ?? ''), undefined, optString(p.user_id)),
      command: p.command.replace(/^\//, ''),
      ...(typeof p.text === 'string' && { text: p.text }),
      at: Date.now(),
      raw: p,
    }
  }

  // Interactive block actions (button/select callbacks).
  if (p.type === 'block_actions') {
    const actions = (p.actions as Array<Record<string, unknown>> | undefined) ?? []
    const action = actions[0] ?? {}
    const channel = (p.channel as { id?: string } | undefined)?.id ?? ''
    const user = (p.user as { id?: string } | undefined)?.id
    const callbackId = optString(action.action_id) ?? optString(action.value)
    return {
      provider: 'slack',
      eventId: String(p.trigger_id ?? action.action_id ?? `${channel}:${Date.now()}`),
      type: 'callback',
      target: target(channel, undefined, user),
      ...(callbackId !== undefined && { callbackId }),
      at: Date.now(),
      raw: p,
    }
  }

  if (p.type === 'event_callback') {
    const inner = p.event as Record<string, unknown> | undefined
    if (inner === undefined) return null
    const channel = String(inner.channel ?? p.channel_id ?? '')
    const user = optString(inner.user)
    const at = secondsToMs(inner.event_ts ?? inner.ts) ?? Date.now()
    const eventId = String(p.event_id ?? inner.ts ?? `${channel}:${at}`)

    if (inner.type === 'reaction_added' || inner.type === 'reaction_removed') {
      const item = inner.item as { channel?: string; ts?: string } | undefined
      return {
        provider: 'slack',
        eventId,
        type: 'reaction',
        target: target(item?.channel ?? channel, undefined, user),
        ...(item?.ts !== undefined && { messageId: item.ts }),
        ...(typeof inner.reaction === 'string' && { reaction: inner.reaction }),
        at,
        raw: p,
      }
    }

    if (
      inner.type === 'message' &&
      (inner.subtype === 'message_changed' || inner.message !== undefined)
    ) {
      const edited = inner.message as Record<string, unknown> | undefined
      return {
        provider: 'slack',
        eventId,
        type: 'edit',
        target: target(channel, optString(inner.thread_ts), optString(edited?.user) ?? user),
        ...(edited?.ts !== undefined && { messageId: String(edited.ts) }),
        ...(typeof edited?.text === 'string' && { text: edited.text }),
        at,
        raw: p,
      }
    }

    if (inner.type === 'message' || inner.type === 'app_mention') {
      return {
        provider: 'slack',
        eventId,
        type: 'message',
        target: target(channel, optString(inner.thread_ts), user),
        ...(inner.ts !== undefined && { messageId: String(inner.ts) }),
        ...(typeof inner.text === 'string' && { text: inner.text }),
        at,
        raw: p,
      }
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

function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function secondsToMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? Math.round(n * 1000) : undefined
}
