import { IntegrationBase } from './base.js'
import type { DiscordConfig, DiscordMessageTrigger, DiscordWebhookEvent } from './types.js'

/**
 * Discord integration for skelm pipelines.
 *
 * Mirrors the Slack connector shape: send messages, receive webhook
 * interactions, react to existing messages, optionally register slash
 * commands. The trust boundary is identical — credentials resolve through
 * the gateway, not via env directly.
 */
export class DiscordIntegration extends IntegrationBase {
  readonly id = 'discord' as const
  readonly name = 'Discord'
  readonly capabilities = {
    canTrigger: true,
    canReceiveWebhooks: true,
    canPoll: false,
    canSendNotifications: true,
  }

  private readonly apiBase = 'https://discord.com/api/v10'
  private botToken: string | null = null

  protected async validateCredentials(): Promise<void> {
    const { botToken } = (this.config as DiscordConfig).credentials
    if (!botToken) {
      throw new Error('Discord credentials missing: botToken required')
    }
    this.botToken = String(botToken)
  }

  protected async performHealthCheck(): Promise<boolean> {
    return this.botToken !== null
  }

  protected async setupWebhook(): Promise<void> {
    // Discord interactions are received on whatever endpoint the operator
    // exposed in the developer portal. There is nothing to register at
    // runtime; the URL is a portal-side configuration.
  }

  protected async cleanupWebhook(): Promise<void> {
    // Symmetric: nothing to deregister.
  }

  /**
   * Convert a Discord interaction payload into pipeline run input.
   * Returns null for events the integration does not handle.
   */
  async eventToRunInput(event: DiscordWebhookEvent): Promise<Record<string, unknown> | null> {
    // Type 1 — PING. Used by Discord to verify the webhook URL. The
    // operator's webhook handler must respond with { type: 1 }; the
    // pipeline does not need to run.
    if (event.type === 1) {
      return { type: 'discord-ping' }
    }

    // Type 2 — APPLICATION_COMMAND (slash command).
    if (event.type === 2) {
      return {
        trigger: {
          type: 'discord-slash-command',
          channel: event.channel_id,
          guild: event.guild_id,
          user: event.user?.id ?? event.member?.user?.id,
          name: event.data?.name,
          options: event.data?.options ?? [],
          token: event.token,
          timestamp: Date.now(),
        },
      }
    }

    // Type 3 — MESSAGE_COMPONENT (button / select-menu interactions).
    if (event.type === 3) {
      return {
        trigger: {
          type: 'discord-component',
          channel: event.channel_id,
          guild: event.guild_id,
          user: event.user?.id ?? event.member?.user?.id,
          customId: event.data?.custom_id,
          token: event.token,
          timestamp: Date.now(),
        },
      }
    }

    return null
  }

  /**
   * Send a message to a Discord channel via the REST API.
   * Pass `threadId` to post into a thread; pass `replyTo` to reply.
   */
  async sendNotification(
    message: string,
    options?: {
      channelId?: string
      threadId?: string
      replyTo?: string
    },
  ): Promise<{ id?: string }> {
    const channelId = options?.channelId ?? (this.config as DiscordConfig).credentials.channelId
    if (!channelId) {
      throw new Error('No channel specified for Discord notification')
    }
    if (this.botToken === null) {
      throw new Error('Discord integration not initialized; call validate() first')
    }
    const body: Record<string, unknown> = { content: message }
    if (options?.replyTo) {
      body.message_reference = { message_id: options.replyTo }
    }
    const target = options?.threadId ?? channelId
    const response = await fetch(`${this.apiBase}/channels/${target}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`Discord sendNotification failed (${response.status} ${response.statusText})`)
    }
    const json = (await response.json()) as { id?: string }
    return json.id !== undefined ? { id: json.id } : {}
  }

  /** React to an existing message with a unicode emoji. */
  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (this.botToken === null) {
      throw new Error('Discord integration not initialized; call validate() first')
    }
    const encoded = encodeURIComponent(emoji)
    const url = `${this.apiBase}/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`
    const response = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bot ${this.botToken}` },
    })
    if (!response.ok) {
      throw new Error(`Discord react failed (${response.status} ${response.statusText})`)
    }
  }

  /**
   * Verify a Discord interaction signature. Discord uses Ed25519 with the
   * application's public key over `timestamp + raw body`. Returns true on
   * a valid signature.
   *
   * The operator passes the raw request body and headers from their
   * webhook handler. We deliberately do not buffer or re-serialize the
   * body — Discord rejects re-serialized payloads.
   */
  async verifySignature(args: {
    publicKey: string
    timestamp: string
    rawBody: string
    signature: string
  }): Promise<boolean> {
    const { publicKey, timestamp, rawBody, signature } = args
    if (!publicKey || !timestamp || !signature) return false
    const { webcrypto } = await import('node:crypto')
    const subtle = webcrypto.subtle
    const message = new TextEncoder().encode(timestamp + rawBody)
    const sig = hexToBytes(signature)
    const pub = hexToBytes(publicKey)
    if (sig.length !== 64 || pub.length !== 32) return false
    try {
      const key = await subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify'])
      return await subtle.verify('Ed25519', key, sig, message)
    } catch {
      return false
    }
  }

  /** Convenience: project a slash-command interaction into a typed trigger. */
  toMessageTrigger(event: DiscordWebhookEvent): DiscordMessageTrigger | null {
    if (event.type !== 2 && event.type !== 3) return null
    const userId = event.user?.id ?? event.member?.user?.id
    if (!event.channel_id || !userId) return null
    const content =
      event.data?.options?.find((o) => typeof o.value === 'string')?.value ?? event.data?.name ?? ''
    return {
      channelId: event.channel_id,
      userId,
      ...(event.user?.username && { username: event.user.username }),
      content: String(content),
      receivedAt: new Date(),
    }
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) return new Uint8Array(0)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
