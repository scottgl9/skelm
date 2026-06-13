/**
 * Discord REST/gateway payload shapes used by this package. Only the fields the
 * adapter reads are typed; everything else is carried opaquely in `raw`.
 */

/** Stable provider id for Discord across the SDK surface. */
export const DISCORD_PROVIDER = 'discord' as const

/** Discord REST API base. The adapter only ever talks to this host. */
export const DISCORD_API_BASE = 'https://discord.com/api/v10'

/** The single host the egress policy must allow for the default REST path. */
export const DISCORD_API_HOST = 'discord.com'

/** A raw Discord message attachment. */
export interface DiscordAttachment {
  readonly id?: string
  readonly filename?: string
  readonly content_type?: string
  readonly url?: string
  readonly size?: number
}

/** A raw Discord gateway dispatch event (`{ t, d }`). */
export interface DiscordGatewayDispatch {
  /** Dispatch type, e.g. `MESSAGE_CREATE`. */
  readonly t: string
  /** Dispatch payload. */
  readonly d: Readonly<Record<string, unknown>>
}

/** A raw Discord interaction payload (webhook POST body). */
export interface DiscordInteraction {
  readonly id?: string
  /** 1 = PING, 2 = APPLICATION_COMMAND, 3 = MESSAGE_COMPONENT. */
  readonly type: number
  readonly channel_id?: string
  readonly guild_id?: string
  readonly data?: Readonly<Record<string, unknown>>
  readonly member?: { readonly user?: { readonly id?: string } }
  readonly user?: { readonly id?: string }
  readonly token?: string
}

/** A raw Discord message resource returned by the REST API. */
export interface DiscordMessage {
  readonly id: string
  readonly channel_id: string
  readonly content?: string
  readonly attachments?: readonly DiscordAttachment[]
}

/** A raw Discord channel resource. */
export interface DiscordChannel {
  readonly id: string
  readonly name?: string
  /** 0 = guild text, 1 = DM, 11 = public thread, … */
  readonly type?: number
  readonly member_count?: number
}
