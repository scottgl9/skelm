/**
 * Discord trigger implementation
 *
 * Receives Discord events via Discord API
 */

import { TriggerPluginBase } from './base.js'
import type { TriggerConfig, TriggerType, TriggerEvent, TriggerHealthStatus } from './types.js'

/**
 * Discord message structure
 */
export interface DiscordMessage {
  id: string
  channel_id: string
  guild_id?: string
  author: {
    id: string
    username: string
    discriminator: string
    bot?: boolean
  }
  content: string
  timestamp: string
  edited_timestamp: string | null
  attachments: Array<{
    id: string
    filename: string
    url: string
  }>
  embeds: unknown[]
  mentions: unknown[]
  mention_roles: string[]
  pinned: boolean
  type: number
}

/**
 * Discord interaction structure
 */
export interface DiscordInteraction {
  id: string
  type: number
  data: {
    component_type?: number
    custom_id?: string
    values?: string[]
  }
  guild_id?: string
  channel_id: string
  member?: {
    user: {
      id: string
      username: string
      discriminator: string
    }
  }
  user?: {
    id: string
    username: string
    discriminator: string
  }
  token: string
  version: number
}

/**
 * Discord trigger configuration
 */
export interface DiscordTriggerConfig extends TriggerConfig {
  /** Discord bot token */
  botToken: string
  /** Discord client ID */
  clientId: string
  /** Channel IDs to listen to */
  channelIds: string[]
  /** Guild IDs to listen to (optional) */
  guildIds?: string[]
  /** Event types to subscribe to */
  events?: ('message' | 'interaction' | 'reaction')[]
  /** Optional workflow ID to invoke */
  workflowId?: string
  /** Optional input data to pass to the workflow */
  input?: unknown
}

/**
 * Discord trigger plugin
 *
 * Note: This is a simplified implementation. For production use,
 * consider using discord.js or discord.js-rest for full client functionality.
 */
export class DiscordTrigger extends TriggerPluginBase {
  private isRunning: boolean = false

  constructor(id: string, name: string, description?: string) {
    super(id, name, '1.0.0', description)
  }

  override getTriggerType(): TriggerType {
    return 'discord'
  }

  override async doInitialize(config: DiscordTriggerConfig): Promise<void> {
    // Validate required config
    if (!config.botToken) {
      throw new Error('Discord trigger requires botToken')
    }
    if (!config.clientId) {
      throw new Error('Discord trigger requires clientId')
    }
    if (!config.channelIds || config.channelIds.length === 0) {
      throw new Error('Discord trigger requires at least one channelId')
    }

    this.config = config
    this.logger.info(`Initialized Discord trigger for client ${config.clientId}`)
  }

  override async doStart(): Promise<void> {
    const config = this.config as DiscordTriggerConfig | null
    if (!config) {
      throw new Error('Discord trigger not initialized')
    }

    this.isRunning = true
    this.logger.info(`Discord trigger started, listening to ${config.channelIds.length} channels`)

    // In a real implementation, this would:
    // 1. Create a Discord client
    // 2. Login with the bot token
    // 3. Set up event listeners for messages and interactions
    // 4. Filter events based on configuration

    // For now, we just mark as running
    // The actual event processing would happen via processMessage() and processInteraction()
  }

  override async doStop(): Promise<void> {
    this.isRunning = false
    this.logger.info('Discord trigger stopped')
  }

  override async doHealthCheck(): Promise<TriggerHealthStatus> {
    const config = this.config as DiscordTriggerConfig | null
    return {
      healthy: config !== null && this.isRunning,
      status: this.isRunning ? 'listening' : 'not-running',
      details: {
        clientId: config?.clientId,
        channelCount: config?.channelIds.length || 0,
        guildCount: config?.guildIds?.length || 0,
      },
    }
  }

  /**
   * Check if a channel is monitored
   */
  private isMonitoredChannel(channelId: string): boolean {
    const config = this.config as DiscordTriggerConfig | null
    return config?.channelIds.includes(channelId) ?? false
  }

  /**
   * Process a Discord message
   */
  async processMessage(message: DiscordMessage): Promise<void> {
    const config = this.config as DiscordTriggerConfig | null
    if (!config) {
      throw new Error('Discord trigger not initialized')
    }

    // Check if message is from a monitored channel
    if (!this.isMonitoredChannel(message.channel_id)) {
      this.logger.debug(`Ignoring message from unmonitored channel: ${message.channel_id}`)
      return
    }

    // Skip bot messages
    if (message.author.bot) {
      this.logger.debug(`Ignoring bot message: ${message.id}`)
      return
    }

    // Create trigger event
    const triggerEvent: TriggerEvent = {
      eventId: message.id,
      triggerId: this.id,
      triggerType: 'discord',
      timestamp: new Date(message.timestamp),
      payload: {
        content: message.content,
        attachments: message.attachments,
      },
      metadata: {
        source: 'discord',
        discordMessageId: message.id,
        discordChannelId: message.channel_id,
        discordGuildId: message.guild_id,
        discordAuthor: message.author.username,
        discordAuthorId: message.author.id,
        ...(config.workflowId !== undefined && { workflowId: config.workflowId }),
      },
    }

    // Emit trigger event
    await this.emitEvent(triggerEvent)

    this.logger.debug(
      `Discord message from ${message.author.username}: ${message.content.substring(0, 50)}...`,
    )
  }

  /**
   * Process a Discord interaction
   */
  async processInteraction(interaction: DiscordInteraction): Promise<void> {
    const config = this.config as DiscordTriggerConfig | null
    if (!config) {
      throw new Error('Discord trigger not initialized')
    }

    // Check if interaction is from a monitored channel
    if (!this.isMonitoredChannel(interaction.channel_id)) {
      this.logger.debug(`Ignoring interaction from unmonitored channel: ${interaction.channel_id}`)
      return
    }

    // Get user info
    const user = interaction.user || interaction.member?.user
    if (!user) {
      this.logger.warn('Discord interaction without user')
      return
    }

    // Create trigger event
    const triggerEvent: TriggerEvent = {
      eventId: interaction.id,
      triggerId: this.id,
      triggerType: 'discord',
      timestamp: new Date(),
      payload: {
        type: interaction.type,
        data: interaction.data,
      },
      metadata: {
        source: 'discord',
        discordInteractionId: interaction.id,
        discordChannelId: interaction.channel_id,
        discordGuildId: interaction.guild_id,
        discordUser: user.username,
        discordUserId: user.id,
        ...(config.workflowId !== undefined && { workflowId: config.workflowId }),
      },
    }

    // Emit trigger event
    await this.emitEvent(triggerEvent)

    this.logger.debug(`Discord interaction from ${user.username}`)
  }

  /**
   * Get the configured channels
   */
  getChannelIds(): string[] {
    const config = this.config as DiscordTriggerConfig | null
    return config?.channelIds || []
  }
}

/**
 * Create a Discord trigger
 */
export function createDiscordTrigger(
  id: string,
  name: string,
  description?: string,
): DiscordTrigger {
  return new DiscordTrigger(id, name, description)
}
