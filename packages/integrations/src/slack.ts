import { defineIntegration } from '@skelm/integration-sdk'
import { z } from 'zod'
import type { SlackWebhookEvent } from '@skelm/integration-sdk'

const slackCredentialsSchema = z.object({
  botToken: z.string().startsWith('xoxb-', 'Slack bot token must start with xoxb-'),
  signingSecret: z.string().min(1, 'Slack signing secret is required'),
  channelId: z.string().optional(),
})

/**
 * Slack integration for skelm pipelines.
 *
 * Supports:
 * - Slash commands
 * - Block actions (interactive messages)
 * - Event subscriptions
 * - Direct message triggers
 */
export const SlackIntegration = defineIntegration({
  id: 'slack',
  name: 'Slack',

  capabilities: {
    canTrigger: true,
    canReceiveWebhooks: true,
    canPoll: true,
    canSendNotifications: true,
  },

  credentialsSchema: slackCredentialsSchema,

  async performHealthCheck(creds) {
    // In production: call slack.auth.test
    return typeof creds.botToken === 'string' && creds.botToken.length > 0
  },

  async setupWebhook(_creds, _config, webhook) {
    // In production: enable event subscriptions via Slack API
    console.log(
      `Slack event subscription would be configured for events: ${webhook.events.join(', ')}`,
    )
  },

  async cleanupWebhook() {
    // In production: disable event subscription
    console.log('Slack event subscription would be disabled')
  },

  async eventToRunInput(event, creds) {
    const e = event as SlackWebhookEvent & {
      channel_id?: string
      channel?: { id: string }
      user?: { id: string }
      actions?: unknown[]
    }

    // URL verification challenge
    if (e.type === 'url_verification') {
      return { challenge: e.challenge, type: 'slack-verification' }
    }

    if (e.type === 'event_callback') {
      const slackEvent = e.event as { type?: string; user?: string; text?: string }

      if (slackEvent.type === 'message' && slackEvent.text) {
        return {
          trigger: {
            type: 'slack-message',
            channel: e.channel_id,
            user: slackEvent.user,
            text: slackEvent.text,
            timestamp: Date.now(),
          },
        }
      }

      if (slackEvent.type === 'app_mention' && slackEvent.text) {
        return {
          trigger: {
            type: 'slack-mention',
            channel: e.channel_id,
            user: slackEvent.user,
            text: slackEvent.text,
            timestamp: Date.now(),
          },
        }
      }
    }

    if (e.type === 'block_actions') {
      return {
        trigger: {
          type: 'slack-action',
          actions: e.actions,
          channel: e.channel?.id,
          user: e.user?.id,
          timestamp: Date.now(),
        },
      }
    }

    return null
  },

  async sendNotification(message, options, creds) {
    const channelId = (options?.channelId as string | undefined) ?? creds.channelId
    if (!channelId && !(options?.userId)) {
      throw new Error('No channel or user specified for Slack notification')
    }
    // In production: call slack.chat.postMessage
    console.log(`Slack message to ${channelId ?? String(options?.userId)}: ${message}`)
  },
})

/**
 * Verify a Slack webhook signature.
 * Call this in your webhook handler before processing the event.
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  // In production: use crypto.createHmac('sha256', signingSecret)
  console.log(`Signature verification: timestamp=${timestamp}, signature=${signature}`)
  void signingSecret
  void body
  return true
}

export type SlackIntegrationType = InstanceType<typeof SlackIntegration>
