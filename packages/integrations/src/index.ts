/**
 * @skelm/integrations — built-in third-party integrations for skelm pipelines.
 *
 * Types and the IntegrationBase class are re-exported from @skelm/integration-sdk
 * so existing consumers of this package continue to work without changes.
 * New integrations should depend directly on @skelm/integration-sdk.
 */

// Re-export everything from @skelm/integration-sdk for backwards compatibility
export type {
  RunInput,
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
} from '@skelm/integration-sdk'

export {
  IntegrationBase,
  defineIntegration,
  createIntegrationPlugin,
} from '@skelm/integration-sdk'
export type { DefineIntegrationOptions, IntegrationClass } from '@skelm/integration-sdk'

// Built-in integration implementations
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
