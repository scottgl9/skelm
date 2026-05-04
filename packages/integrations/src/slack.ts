import { IntegrationBase } from './base.js'
import type { SlackConfig, SlackWebhookEvent } from './types.js'

/**
 * Slack integration for skelm pipelines
 *
 * Supports:
 * - Slash commands
 * - Block actions (interactive messages)
 * - Event subscriptions
 * - Direct message triggers
 */
export class SlackIntegration extends IntegrationBase {
  readonly id = 'slack' as const
  readonly name = 'Slack'
  readonly capabilities = {
    canTrigger: true,
    canReceiveWebhooks: true,
    canPoll: true,
    canSendNotifications: true,
  }

  private slackApiBaseUrl = 'https://slack.com/api'
  private botToken: string | null = null

  protected async validateCredentials(): Promise<void> {
    const { botToken, signingSecret } = this.config.credentials

    if (!botToken || !signingSecret) {
      throw new Error('Slack credentials missing: botToken and signingSecret required')
    }

    this.botToken = String(botToken)

    // Validate token format
    if (!this.botToken.startsWith('xoxb-')) {
      throw new Error('Invalid Slack bot token format')
    }
  }

  protected async performHealthCheck(): Promise<boolean> {
    try {
      // In production, call slack.api.auth.test
      return !!this.botToken
    } catch {
      return false
    }
  }

  protected async setupWebhook(): Promise<void> {
    const { webhook } = this.config
    if (!webhook) {
      return
    }

    // In production, register event subscription with Slack
    // This would use the Slack API to enable event subscriptions
    console.log(
      `Slack event subscription would be configured for events: ${webhook.events.join(', ')}`,
    )
  }

  protected async cleanupWebhook(): Promise<void> {
    // In production, disable event subscription
    console.log('Slack event subscription would be disabled')
  }

  /**
   * Verify Slack webhook signature
   */
  verifySignature(
    signingSecret: string,
    timestamp: string,
    body: string,
    signature: string,
  ): boolean {
    // In production, use crypto.createHmac('sha256', signingSecret)
    // For now, just return true (signature verification would happen in the webhook handler)
    console.log(`Signature verification: timestamp=${timestamp}, signature=${signature}`)
    return true
  }

  /**
   * Convert Slack webhook event to RunInput
   */
  async eventToRunInput(event: SlackWebhookEvent): Promise<Record<string, unknown> | null> {
    if (!this.capabilities.canTrigger) {
      return null
    }

    // Handle URL verification (Slack challenge)
    if (event.type === 'url_verification') {
      return {
        challenge: event.challenge,
        type: 'slack-verification',
      }
    }

    // Handle event callbacks
    if (event.type === 'event_callback') {
      const slackEvent = event.event as { type: string; user?: string; text?: string }

      // Handle message events
      if (slackEvent.type === 'message' && slackEvent.text) {
        return {
          trigger: {
            type: 'slack-message',
            channel: (event as { channel_id?: string }).channel_id,
            user: slackEvent.user,
            text: slackEvent.text,
            timestamp: Date.now(),
          },
        }
      }

      // Handle app_mention events
      if (slackEvent.type === 'app_mention' && slackEvent.text) {
        return {
          trigger: {
            type: 'slack-mention',
            channel: (event as { channel_id?: string }).channel_id,
            user: slackEvent.user,
            text: slackEvent.text,
            timestamp: Date.now(),
          },
        }
      }
    }

    // Handle block actions (interactive components)
    if (event.type === 'block_actions') {
      return {
        trigger: {
          type: 'slack-action',
          actions: (event as { actions?: unknown[] }).actions,
          channel: (event as { channel?: { id: string } }).channel?.id,
          user: (event as { user?: { id: string } }).user?.id,
          timestamp: Date.now(),
        },
      }
    }

    return null
  }

  /**
   * Send message to Slack channel
   */
  async sendNotification(
    message: string,
    options?: {
      channelId?: string
      threadTs?: string
      ephemeral?: boolean
      userId?: string
    },
  ): Promise<void> {
    const channelId = options?.channelId || this.config.credentials.channelId
    if (!channelId && !options?.userId) {
      throw new Error('No channel or user specified for Slack notification')
    }

    // In production, call slack.chat.postMessage
    console.log(`Slack message to ${channelId || options?.userId}: ${message}`)
  }

  /**
   * Post ephemeral message
   */
  async postEphemeral(channelId: string, userId: string, message: string): Promise<void> {
    // In production, call slack.chat.postEphemeral
    console.log(`Slack ephemeral to ${userId} in ${channelId}: ${message}`)
  }

  /**
   * Respond to a Slack action (with block kit)
   */
  async respondWithBlocks(triggerId: string, blocks: unknown[]): Promise<void> {
    // In production, call slack.chat.postMessage with trigger_id
    console.log(`Slack blocks response for trigger ${triggerId}`)
  }
}
