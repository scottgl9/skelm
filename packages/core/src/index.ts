// Public surface of @skelm/core. Anything exported from this file is part
// of the public API; anything not re-exported here is internal.

export const VERSION = '0.1.0'

export * from './acp/index.js'
export * from './anthropic/index.js'
export { DEFAULT_CONFIG, defineConfig } from './config.js'
export type {
  SkelmConfig,
  SkelmConfigBackendEntry,
  SkelmConfigBackends,
  SkelmConfigSecrets,
  SkelmConfigServer,
  SkelmConfigStorage,
} from './config.js'

export {
  BackendCapabilityError,
  BackendNotFoundError,
  BackendRegistry,
} from './backend.js'
export type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  BackendId,
  McpServerConfig,
  InferRequest,
  InferResponse,
  PromptMessage,
  SkelmBackend,
  ToolPermissionEnforcement,
  Usage,
} from './backend.js'
export { ProviderPluginBase, ProviderError, ProviderAuthenticationError, ProviderRateLimitError, ProviderTimeoutError, ProviderNotFoundError } from './providers/base.js'
export type { ProviderCapabilities, ProviderSpecificCapabilities } from './providers/base.js'
export { ProviderCapabilityRegistry, globalCapabilityRegistry } from './providers/registry.js'
export type { ProviderQuery } from './providers/registry.js'
export { selectProviderForTask, selectProvider, ProviderSelectionError } from './providers/selector.js'
export type { TaskRequirements, ProviderSelection } from './providers/selector.js'
export { TriggerPluginBase, TriggerState, TriggerError, TriggerInitializationError, TriggerStartError, TriggerStopError, TriggerValidationError } from './triggers/base.js'
export type { TriggerConfig, TriggerType, TriggerEvent, TriggerEventHandler, WorkflowInvocation, TriggerHealthStatus } from './triggers/types.js'
export { TriggerRegistry } from './triggers/registry.js'
export { CronTrigger, createCronTrigger } from './triggers/cron.js'
export type { CronTriggerConfig } from './triggers/cron.js'
export { WebhookTrigger, createWebhookTrigger } from './triggers/webhook.js'
export type { WebhookTriggerConfig } from './triggers/webhook.js'
export { SlackTrigger, createSlackTrigger } from './triggers/slack.js'
export type { SlackTriggerConfig, SlackEvent, SlackBlockAction, SlackCommand } from './triggers/slack.js'
export { MatrixTrigger, createMatrixTrigger } from './triggers/matrix.js'
export type { MatrixTriggerConfig, MatrixEvent, MatrixMessageEvent } from './triggers/matrix.js'
export { GitHubTrigger, createGitHubTrigger } from './triggers/github.js'
export type { GitHubTriggerConfig, GitHubWebhookEvent, GitHubPushEvent, GitHubPullRequestEvent, GitHubIssueCommentEvent } from './triggers/github.js'
export { DiscordTrigger, createDiscordTrigger } from './triggers/discord.js'
export type { DiscordTriggerConfig, DiscordMessage, DiscordInteraction } from './triggers/discord.js'
export { CustomTrigger, createCustomTrigger } from './triggers/custom.js'
export type { CustomTriggerConfig } from './triggers/custom.js'
export { ScriptTrigger, createScriptTrigger } from './triggers/script.js'
export type { ScriptTriggerConfig } from './triggers/script.js'
export type { ProviderModel, PluginMetadata, PluginConfig, PluginLifecycle, PluginHealthStatus, PluginType, SkelmPlugin, ProviderPlugin, WorkflowPlugin } from './plugins.js'
export {
  agent,
  branch,
  code,
  forEach,
  idempotent,
  llm,
  loop,
  parallel,
  pipeline,
  pipelineStep,
  wait,
} from './builders.js'
export {
  PermissionDeniedError,
  RunCancelledError,
  StepError,
  WaitTimeoutError,
  serializeError,
} from './errors.js'
export { EventBus, terminalEventTypeFor } from './events.js'
export type { EventListener, RunEvent, RunEventType } from './events.js'
export * from './mcp/index.js'
export * from './openai/index.js'
export { MemoryRunStore, SqliteRunStore } from './run-store.js'
export type {
  AuditEntry,
  RunFilter,
  RunStore,
  RunSummary,
  SqliteRunStoreOptions,
} from './run-store.js'
export { WorkspaceManager } from './workspace.js'
export type {
  PreparedWorkspace,
  WorkspaceManagerOptions,
  WorkspaceMetadata,
  WorkspaceSummary,
} from './workspace.js'
export {
  resolvePermissions,
  TrustEnforcer,
} from './permissions.js'
export type {
  AgentPermissions,
  ApprovalPolicy,
  EnforceDecision,
  NetworkPolicy,
  PermissionDenialReason,
  PermissionDimension,
  ResolvedPolicy,
  ResolvedToolMatcher,
  ToolMatcher,
} from './permissions.js'
export type { RunHandle, RunOptions, WaitRequest } from './runner.js'
export { runPipeline, Runner, SchemaValidationError } from './runner.js'
export type { SkelmSchema } from './schema.js'
export type {
  AgentStep,
  BranchStep,
  CodeStep,
  Context,
  ForEachStep,
  LlmStep,
  LoopStep,
  ParallelOnError,
  ParallelStep,
  ParallelWaitFor,
  Pipeline,
  PipelineStep,
  RetryPolicy,
  Run,
  RunId,
  RunMetadata,
  RunStatus,
  SerializedError,
  Step,
  StepId,
  StepKind,
  StepResult,
  StepStatus,
  WaitStep,
} from './types.js'
