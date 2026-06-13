/**
 * Normalization of raw Discord gateway dispatches and interaction payloads into
 * the SDK's normalized {@link InboundEvent}.
 *
 * Two inbound shapes exist:
 *   - Gateway dispatch events (`MESSAGE_CREATE`, `MESSAGE_UPDATE`,
 *     `MESSAGE_DELETE`, `MESSAGE_REACTION_ADD`) delivered over the gateway
 *     websocket or a relay.
 *   - Interaction payloads (POSTed to the interactions webhook): slash commands
 *     (`type: 2`, `APPLICATION_COMMAND`) and message-component interactions
 *     (`type: 3`, `MESSAGE_COMPONENT`) such as button presses.
 *
 * Each normalizer returns `null` for payloads that carry nothing routable
 * (e.g. the interaction PING the gateway answers itself), so the caller can
 * skip them cleanly rather than emitting empty events.
 */

import type { InboundEvent, MediaAttachment } from '@skelm/integration-sdk'
import { DISCORD_PROVIDER } from './types.js'
import type { DiscordAttachment, DiscordGatewayDispatch, DiscordInteraction } from './types.js'

function toMediaKind(contentType: string | undefined): MediaAttachment['kind'] {
  if (contentType === undefined) return 'file'
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  if (contentType.startsWith('audio/')) return 'voice'
  return 'file'
}

function normalizeAttachments(
  attachments: readonly DiscordAttachment[] | undefined,
): readonly MediaAttachment[] | undefined {
  if (attachments === undefined || attachments.length === 0) return undefined
  return attachments.map((a) => ({
    kind: toMediaKind(a.content_type),
    contentType: a.content_type ?? 'application/octet-stream',
    ...(a.filename !== undefined ? { filename: a.filename } : {}),
    ...(a.url !== undefined ? { url: a.url } : {}),
    ...(a.size !== undefined ? { size: a.size } : {}),
  }))
}

function snowflakeToMillis(id: string): number | undefined {
  // Discord snowflakes embed a millisecond timestamp since 2015-01-01.
  if (!/^\d+$/.test(id)) return undefined
  const DISCORD_EPOCH = 1420070400000
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH
}

/**
 * Normalize a raw Discord gateway dispatch (`{ t, d }`) into an
 * {@link InboundEvent}. Returns `null` for dispatch types this adapter does not
 * surface.
 */
export function normalizeGatewayDispatch(dispatch: DiscordGatewayDispatch): InboundEvent | null {
  const d = dispatch.d
  switch (dispatch.t) {
    case 'MESSAGE_CREATE':
    case 'MESSAGE_UPDATE': {
      const messageId = String(d.id ?? '')
      const channelId = String(d.channel_id ?? '')
      if (messageId === '' || channelId === '') return null
      const attachments = normalizeAttachments(d.attachments as DiscordAttachment[] | undefined)
      const authorId = (d.author as { id?: string } | undefined)?.id
      return {
        provider: DISCORD_PROVIDER,
        eventId: `${dispatch.t}:${messageId}`,
        type: dispatch.t === 'MESSAGE_CREATE' ? 'message' : 'edit',
        target: {
          conversationId: channelId,
          ...(authorId !== undefined ? { userId: String(authorId) } : {}),
        },
        messageId,
        ...(typeof d.content === 'string' ? { text: d.content } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
        at: snowflakeToMillis(messageId) ?? Date.now(),
        raw: d,
      }
    }
    case 'MESSAGE_DELETE': {
      const messageId = String(d.id ?? '')
      const channelId = String(d.channel_id ?? '')
      if (messageId === '' || channelId === '') return null
      return {
        provider: DISCORD_PROVIDER,
        eventId: `MESSAGE_DELETE:${messageId}`,
        type: 'delete',
        target: { conversationId: channelId },
        messageId,
        at: Date.now(),
        raw: d,
      }
    }
    case 'MESSAGE_REACTION_ADD': {
      const messageId = String(d.message_id ?? '')
      const channelId = String(d.channel_id ?? '')
      if (messageId === '' || channelId === '') return null
      const emoji = (d.emoji as { name?: string; id?: string } | undefined)?.name
      const userId = d.user_id !== undefined ? String(d.user_id) : undefined
      return {
        provider: DISCORD_PROVIDER,
        eventId: `MESSAGE_REACTION_ADD:${messageId}:${userId ?? ''}:${emoji ?? ''}`,
        type: 'reaction',
        target: {
          conversationId: channelId,
          ...(userId !== undefined ? { userId } : {}),
        },
        messageId,
        ...(emoji !== undefined ? { reaction: emoji } : {}),
        at: Date.now(),
        raw: d,
      }
    }
    default:
      return null
  }
}

/** Parsed slash-command invocation. */
export interface ParsedSlashCommand {
  readonly name: string
  /** Option name → value, flattened from the command's option tree. */
  readonly options: Readonly<Record<string, string | number | boolean>>
  /** Subcommand name when the invocation selected one. */
  readonly subcommand?: string
}

interface RawCommandOption {
  name: string
  type: number
  value?: string | number | boolean
  options?: RawCommandOption[]
}

/**
 * Parse a Discord `APPLICATION_COMMAND` interaction into a flat command name
 * plus options. Subcommand (type 1) and subcommand-group (type 2) options nest;
 * this flattens one subcommand level and merges its leaf options.
 */
export function parseSlashCommand(interaction: DiscordInteraction): ParsedSlashCommand | null {
  if (interaction.type !== 2 || interaction.data === undefined) return null
  const data = interaction.data as {
    name?: string
    options?: RawCommandOption[]
  }
  if (typeof data.name !== 'string') return null
  const options: Record<string, string | number | boolean> = {}
  let subcommand: string | undefined
  const visit = (opts: RawCommandOption[] | undefined): void => {
    for (const opt of opts ?? []) {
      if (opt.type === 1 || opt.type === 2) {
        if (opt.type === 1) subcommand = opt.name
        visit(opt.options)
      } else if (opt.value !== undefined) {
        options[opt.name] = opt.value
      }
    }
  }
  visit(data.options)
  return {
    name: data.name,
    options,
    ...(subcommand !== undefined ? { subcommand } : {}),
  }
}

/**
 * Normalize a Discord interaction (slash command or message component) into an
 * {@link InboundEvent}. Returns `null` for the PING (`type: 1`) handshake and
 * for interaction types this adapter does not surface.
 */
export function normalizeInteraction(interaction: DiscordInteraction): InboundEvent | null {
  const channelId = interaction.channel_id ?? ''
  const userId = interaction.member?.user?.id ?? interaction.user?.id ?? undefined
  const at =
    interaction.id !== undefined ? (snowflakeToMillis(interaction.id) ?? Date.now()) : Date.now()
  switch (interaction.type) {
    case 2: {
      const parsed = parseSlashCommand(interaction)
      if (parsed === null || channelId === '') return null
      return {
        provider: DISCORD_PROVIDER,
        eventId: `interaction:${interaction.id ?? parsed.name}`,
        type: 'command',
        target: {
          conversationId: channelId,
          ...(userId !== undefined ? { userId } : {}),
        },
        command: parsed.name,
        at,
        raw: interaction as unknown as Record<string, unknown>,
      }
    }
    case 3: {
      const data = interaction.data as { custom_id?: string } | undefined
      const callbackId = data?.custom_id
      if (callbackId === undefined || channelId === '') return null
      return {
        provider: DISCORD_PROVIDER,
        eventId: `interaction:${interaction.id ?? callbackId}`,
        type: 'callback',
        target: {
          conversationId: channelId,
          ...(userId !== undefined ? { userId } : {}),
        },
        callbackId,
        at,
        raw: interaction as unknown as Record<string, unknown>,
      }
    }
    default:
      return null
  }
}
