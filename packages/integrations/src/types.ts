/**
 * Re-exported from @skelm/integration-sdk.
 * All integration types now live in the SDK so third-party authors
 * and built-in implementations share the same surface.
 */
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
