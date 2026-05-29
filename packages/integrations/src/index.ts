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
  TuiConfig,
} from '@skelm/integration-sdk'

export {
  IntegrationBase,
  defineIntegration,
  createIntegrationPlugin,
} from '@skelm/integration-sdk'
export type { DefineIntegrationOptions, IntegrationClass } from '@skelm/integration-sdk'

// Built-in integration implementations
export {
  GitHubIntegration,
  GitHubApiError,
  githubFetch,
  getAuthenticatedUser,
  registerWebhook,
  deleteWebhook,
  postIssueComment,
  postPullRequestReview,
  type GitHubAuth,
  type GitHubHook,
  type RegisterWebhookParams,
  type DeleteWebhookParams,
  type PostIssueCommentParams,
  type PostPullRequestReviewParams,
  type PullRequestReviewComment,
} from './github.js'
export {
  registerGitHubPrTrigger,
  normalizeGitHubPrEvent,
  verifyGitHubSignature,
  type GitHubPrEventKind,
  type GitHubPrPayload,
  type GitHubPrTriggerSpec,
  type GitHubPrTriggerCoordinator,
} from './github-pr-trigger.js'
export {
  MsGraphIntegration,
  getMsGraphValidationToken,
  verifyMsGraphClientState,
  type MsGraphIntegrationType,
} from './ms-graph.js'
export { SlackIntegration, verifySlackSignature } from './slack.js'
export {
  TelegramIntegration,
  telegramUpdateToInput,
  type CreateTelegramTriggerSourceOptions,
  type TelegramGetUpdatesOptions,
  type TelegramMessageInput,
  type TelegramSendMessageOptions,
  type TelegramTriggerSource,
} from './telegram.js'
export {
  TuiIntegration,
  createRemoteTriggerSource,
  type CreateRemoteTuiTriggerSourceOptions,
  type CreateTuiTriggerSourceOptions,
  type RemoteTuiTriggerSource,
  type TuiFrontend,
  type TuiFrontendFactory,
  type TuiFrontendIo,
  type TuiMessageInput,
  type TuiTriggerSource,
} from './tui.js'

// Integration registry
export { IntegrationRegistry } from './registry.js'
