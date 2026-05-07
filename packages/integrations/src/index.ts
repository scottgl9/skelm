/**
 * @skelm/integrations - Third-party integration abstractions
 *
 * Provides typed connectors for GitHub, Slack, Jira, IMAP, Telegram, etc.
 */

export type {
  IntegrationConfig,
  WebhookConfig,
  RateLimitConfig,
  IntegrationCapabilities,
  Integration,
  GitHubConfig,
  GitHubWebhookEvent,
  GitHubIssueTrigger,
  SlackConfig,
  SlackWebhookEvent,
  JiraConfig,
  JiraIssueTrigger,
  IMAPConfig,
  EmailTrigger,
  TelegramConfig,
  TelegramWebhookEvent,
  TelegramMessageTrigger,
} from './types.js'

// Integration base class
export { IntegrationBase } from './base.js'

// Integration implementations
export { GitHubIntegration } from './github.js'
export { SlackIntegration } from './slack.js'
export {
  TelegramIntegration,
  telegramUpdateToInput,
  type CreateTelegramTriggerSourceOptions,
  type TelegramGetUpdatesOptions,
  type TelegramMessageInput,
  type TelegramSendMessageOptions,
  type TelegramTriggerSource,
} from './telegram.js'

// Integration registry
export { IntegrationRegistry } from './registry.js'
