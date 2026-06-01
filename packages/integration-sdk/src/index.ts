/**
 * @skelm/integration-sdk
 *
 * The public authoring surface for building custom skelm integrations.
 * Install this package when you want to create your own integration;
 * install @skelm/integrations when you want to use the built-in ones.
 */

// Core types
export type {
  RunInput,
  IntegrationConfig,
  WebhookConfig,
  RateLimitConfig,
  IntegrationCapabilities,
  Integration,
  // Provider-specific types (for reference/extension)
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
  ChatUiConfig,
  MatrixConfig,
  MatrixMessageTrigger,
} from './types.js'

// Base class
export { IntegrationBase } from './base.js'

// Factory + plugin adapter
export {
  defineIntegration,
  createIntegrationPlugin,
  IntegrationWorkflowPlugin,
  INTEGRATION_PLUGIN_BRAND,
} from './factory.js'
export type { DefineIntegrationOptions, IntegrationClass } from './factory.js'
