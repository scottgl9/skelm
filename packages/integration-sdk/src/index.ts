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
export {
  IntegrationCredentialsError,
  IntegrationRateLimitError,
  IntegrationSdkError,
  IntegrationUnsupportedOperationError,
} from './errors.js'

// Factory + plugin adapter
export {
  defineIntegration,
  createIntegrationPlugin,
  IntegrationWorkflowPlugin,
  INTEGRATION_PLUGIN_BRAND,
} from './factory.js'
export type { DefineIntegrationOptions, IntegrationClass } from './factory.js'

// Credential model (references only — never values)
export {
  isCredentialReference,
  assertNoSecretValue,
} from './credentials.js'
export type {
  CredentialFieldKind,
  CredentialFieldSchema,
  CredentialSchema,
  CredentialReference,
  Connection,
} from './credentials.js'

// Conversation adapter contract
export { isCapabilityDescriptor } from './conversation.js'
export type {
  MediaKind,
  MediaAttachment,
  ConversationTarget,
  InboundEvent,
  OutboundEvent,
  SentMessageRef,
  ConversationTargetInfo,
  CapabilityDescriptor,
  Unsubscribe,
  ConversationAdapter,
} from './conversation.js'

// Provider registry contracts
export type {
  ProviderCostMetadata,
  ProviderBase,
  ProviderCategory,
  ModelProvider,
  ToolProvider,
  MediaProvider,
  BrowserDriver,
  BrowserProvider,
  MemoryProvider,
  SecretProvider,
  AnyProvider,
  ProviderRegistry,
} from './providers.js'

// Health + test contracts
export { shouldRunLiveTest } from './testing.js'
export type {
  ProviderHealthCheck,
  MockProviderFixture,
  LiveTestDescriptor,
} from './testing.js'

// Delivery target (re-exported from @skelm/core — one canonical shape)
export type { DeliveryTarget } from './delivery.js'

// Universal action/trigger helpers
export {
  verifyHmacSignature,
  normalizeWebhook,
  IdempotencyTracker,
  backoffDelay,
  withRetry,
  RateLimiter,
  paginate,
  httpRequest,
} from './helpers.js'
export type {
  HmacAlgorithm,
  VerifyHmacOptions,
  EventEnvelope,
  WebhookInput,
  RetryOptions,
  Page,
  EgressPolicy,
  HttpRequestOptions,
} from './helpers.js'

// Integration-package manifest extension
export type {
  ActionDefinition,
  TriggerDefinition,
  WebhookVerificationStrategy,
  WebhookEndpointDescriptor,
  AuditRedactionPolicy,
  DashboardSetupMetadata,
  IntegrationPackageManifest,
} from './manifest.js'
