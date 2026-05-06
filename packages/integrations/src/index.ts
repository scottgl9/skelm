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
  DiscordConfig,
  DiscordWebhookEvent,
  DiscordMessageTrigger,
} from './types.js'

// Integration base class
export { IntegrationBase } from './base.js'

// Integration implementations
export { GitHubIntegration } from './github.js'
export { SlackIntegration } from './slack.js'
export { DiscordIntegration } from './discord.js'

// Integration registry
export { IntegrationRegistry } from './registry.js'
