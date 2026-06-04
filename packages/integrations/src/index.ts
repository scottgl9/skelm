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
  ChatUiConfig,
  MatrixConfig,
  MatrixMessageTrigger,
} from '@skelm/integration-sdk'

export {
  IntegrationBase,
  defineIntegration,
  createIntegrationPlugin,
} from '@skelm/integration-sdk'
export type { DefineIntegrationOptions, IntegrationClass } from '@skelm/integration-sdk'

// Built-in integration implementations
export {
  IntegrationApiError,
  IntegrationConfigError,
  IntegrationError,
  IntegrationStateError,
} from './errors.js'
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
  MatrixIntegration,
  matrixSyncToInputs,
  type CreateMatrixTriggerSourceOptions,
  type MatrixMessageInput,
  type MatrixSendMessageOptions,
  type MatrixSyncOptions,
  type MatrixTriggerSource,
} from './matrix.js'
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
  ChatUiIntegration,
  createRemoteTriggerSource,
  type ChatUiTransport,
  type CreateRemoteChatUiTriggerSourceOptions,
  type CreateChatUiTriggerSourceOptions,
  type RemoteChatUiTriggerSource,
  type ChatUiFrontend,
  type ChatUiFrontendFactory,
  type ChatUiFrontendIo,
  type ChatUiMessageInput,
  type ChatUiTriggerSource,
} from './chatui.js'

// Integration registry
export { IntegrationRegistry } from './registry.js'
