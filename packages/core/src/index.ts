// Public surface of @skelm/core. Anything exported from this file is part
// of the public API; anything not re-exported here is internal.

export const VERSION = '0.1.0'

export { createAcpBackend } from './acp/index.js'
export type { AcpBackendOptions } from './acp/index.js'
export { AcpClient, AcpProtocolError } from './acp/index.js'
export type { AcpPromptResult, AcpSpawnOptions } from './acp/index.js'
export { JsonRpcStdioTransport, PROTOCOL_VERSION } from './acp/index.js'
export type {
  AgentCapabilities,
  ClientCapabilities,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpServerSpec,
  SessionNewRequest,
  SessionNewResponse,
  SessionPromptRequest,
  SessionPromptResponse,
  SessionUpdate,
  StopReason,
} from './acp/index.js'

export { createAnthropicBackend } from './anthropic/index.js'
export type { AnthropicBackendOptions } from './anthropic/index.js'
export {
  CONFIG_FILENAMES,
  DEFAULT_CONFIG,
  GATEWAY_CONFIG_FILENAMES,
  defineConfig,
  defineGatewayConfig,
  defineWorkflowConfig,
} from './config.js'
export type {
  SkelmConfig,
  SkelmConfigAgentEntry,
  SkelmConfigAgentmemory,
  SkelmConfigBackendEntry,
  SkelmConfigBackends,
  SkelmConfigMcpServerEntry,
  SkelmConfigRegistries,
  SkelmConfigSecrets,
  SkelmConfigServer,
  SkelmConfigStorage,
  SkelmConfigTriggerSourceEntry,
  SkelmTriggerSource,
} from './config.js'

export {
  AgentMaxTurnsError,
  BackendAuthenticationError,
  BackendCapabilityError,
  BackendConfigError,
  BackendNetworkError,
  BackendNotFoundError,
  BackendRateLimitError,
  BackendRegistry,
  BackendSessionError,
  BackendTimeoutError,
  BackendUnavailableError,
  BackendUpstreamError,
  LLMTruncatedError,
} from './backend.js'
export type {
  AgentmemoryContextBlock,
  AgentmemoryGraphEdge,
  AgentmemoryGraphNode,
  AgentmemoryGraphResult,
  AgentmemoryHandle,
  AgentmemoryHandleFactory,
  AgentmemoryHandleFactoryContext,
  AgentmemoryRecallResult,
  AgentmemorySaveResult,
  AgentmemorySearchHit,
  AgentmemorySearchResult,
  AgentmemorySessionsResult,
  AgentmemorySessionSummary,
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  BackendId,
  ContentPart,
  DelegateResult,
  McpServerConfig,
  InferenceRequest,
  InferenceResponse,
  PromptMessage,
  SkelmBackend,
  ToolPermissionEnforcement,
  Usage,
} from './backend.js'
export {
  extractText as extractPromptText,
  imagePart,
  imagePartFromFile,
  isMultimodal,
  messageHasImage,
  textPart,
} from './content.js'
export {
  ProviderPluginBase,
  ProviderError,
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderNotFoundError,
} from './providers/base.js'
export type { ProviderCapabilities, ProviderSpecificCapabilities } from './providers/base.js'
export { ProviderCapabilityRegistry, globalCapabilityRegistry } from './providers/registry.js'
export type { ProviderQuery } from './providers/registry.js'
export {
  selectProviderForTask,
  selectProvider,
  ProviderSelectionError,
} from './providers/selector.js'
export type { TaskRequirements, ProviderSelection } from './providers/selector.js'
export {
  TriggerPluginBase,
  TriggerState,
  TriggerError,
  TriggerInitializationError,
  TriggerStartError,
  TriggerStopError,
  TriggerValidationError,
} from './triggers/base.js'
export type {
  TriggerConfig,
  TriggerType,
  TriggerEvent,
  TriggerEventHandler,
  WorkflowInvocation,
  TriggerHealthStatus,
} from './triggers/types.js'
export { TriggerRegistry } from './triggers/registry.js'
export { CronTrigger, createCronTrigger } from './triggers/cron.js'
export type { CronTriggerConfig } from './triggers/cron.js'
export { WebhookTrigger, createWebhookTrigger } from './triggers/webhook.js'
export type { WebhookTriggerConfig } from './triggers/webhook.js'
export { SlackTrigger, createSlackTrigger } from './triggers/slack.js'
export type {
  SlackTriggerConfig,
  SlackEvent,
  SlackBlockAction,
  SlackCommand,
} from './triggers/slack.js'
export { MatrixTrigger, createMatrixTrigger } from './triggers/matrix.js'
export type { MatrixTriggerConfig, MatrixEvent, MatrixMessageEvent } from './triggers/matrix.js'
export { GitHubTrigger, createGitHubTrigger } from './triggers/github.js'
export type {
  GitHubTriggerConfig,
  GitHubWebhookEvent,
  GitHubPushEvent,
  GitHubPullRequestEvent,
  GitHubIssueCommentEvent,
} from './triggers/github.js'
export { DiscordTrigger, createDiscordTrigger } from './triggers/discord.js'
export type {
  DiscordTriggerConfig,
  DiscordMessage,
  DiscordInteraction,
} from './triggers/discord.js'
export { CustomTrigger, createCustomTrigger } from './triggers/custom.js'
export type { CustomTriggerConfig } from './triggers/custom.js'
export { ScriptTrigger, createScriptTrigger } from './triggers/script.js'
export type { ScriptTriggerConfig } from './triggers/script.js'
export type {
  ProviderModel,
  PluginMetadata,
  PluginConfig,
  PluginLifecycle,
  PluginHealthStatus,
  PluginType,
  SkelmPlugin,
  ModelPlugin,
  AgentPlugin,
  WorkflowPlugin,
} from './plugins.js'
export { PluginError, PluginLifecycleError, PluginLoadError } from './plugins.js'
export { WorkflowLifecycleError } from './workflows/base.js'
export {
  agent,
  branch,
  check,
  code,
  forEach,
  idempotent,
  invoke,
  infer,
  loop,
  parallel,
  pipeline,
  pipelineStep,
  wait,
} from './builders.js'
export type { TestResult } from './builders.js'
export {
  defaultPromptOf,
  defaultReplyOf,
  isPersistentWorkflow,
  PERSISTENT_TURN_STEP_ID,
  persistentWorkflow,
} from './persistent-workflow.js'
export type {
  PersistentWorkflow,
  PersistentWorkflowAgentDef,
  PersistentWorkflowDef,
} from './persistent-workflow.js'
export {
  DEFAULT_SESSION_LOCK_STALE_MS,
  acquireSession,
  createSessionRecord,
  loadSession,
  PERSISTENT_WORKFLOW_NAMESPACE,
  PersistentSessionLockedError,
  releaseSession,
  saveSession,
} from './persistent-workflow-store.js'
export type { PersistentSessionRecord } from './persistent-workflow-store.js'
export {
  ConfigError,
  AssetPathError,
  DEFAULT_MAX_DELEGATION_DEPTH,
  DelegationCycleError,
  DelegationDepthError,
  ExecConfigError,
  InvokePipelineNotFoundError,
  PermissionDeniedError,
  RegistryError,
  RunCancelledError,
  RunStateError,
  StateConfigError,
  StepError,
  StepTimeoutError,
  WaitTimeoutError,
  serializeError,
  toErrorMessage,
} from './errors.js'
export { EventBus, terminalEventTypeFor } from './events.js'
export type { EventListener, RunEvent, RunEventType } from './events.js'
export { CRON_LOOKAHEAD_MS, nextCronFireTime, parseCronExpression } from './cron-expression.js'
export type { ParsedCronExpression } from './cron-expression.js'
export { parseDuration } from './duration.js'
export { describePipeline, describeStep } from './introspect.js'
export type { DescribedStep, PipelineDescription } from './introspect.js'
export { createRoutingBackend } from './routing-backend.js'
export type { RoutingBackendOptions } from './routing-backend.js'
export { McpClient, McpProtocolError } from './mcp/index.js'
export type { McpSpawnOptions } from './mcp/index.js'
export { createMcpHost } from './mcp/index.js'
export type { McpHost, McpHostedTool } from './mcp/index.js'
export { JsonRpcLineTransport, MCP_PROTOCOL_VERSION } from './mcp/index.js'
export type {
  ToolCallResponse,
  ToolContent,
  ToolDefinition,
  ToolsListResponse,
} from './mcp/index.js'

export { createOpenAIBackend } from './openai/index.js'
export type { OpenAIBackendOptions } from './openai/index.js'
export { ModelProviderBase, ModelRegistry, executeInferStep } from './model-provider.js'
export type {
  ModelProvider,
  ModelProviderConfig,
  ChatMessage,
  LlmCompletion,
} from './model-provider.js'
// Model providers: OpenAI, Anthropic, vllm, sglang, ollama, etc.
// Agent providers: ACP, opencode, pi, github-copilot, etc.
export {
  AgentProviderBase,
  AgentProviderError,
  AgentProviderNotFoundError,
  AgentRegistry,
  executeAgentStep,
} from './agent-provider.js'
export type {
  AgentProvider,
  AgentProviderConfig,
  AgentMessage,
  AgentToolCall,
  AgentToolResult,
} from './agent-provider.js'
export {
  ArtifactMaterializationError,
  ArtifactQuotaExceededError,
  ArtifactValidationError,
  DEFAULT_ARTIFACT_QUOTA_BYTES,
  MemoryRunStore,
  SqliteRunStore,
} from './run-store.js'
export type {
  ArtifactDescriptor,
  ArtifactMaterialization,
  ArtifactMaterializeOptions,
  ArtifactRef,
  ArtifactStore,
  ArtifactStoreHandle,
  AuditEntry,
  ExecutionStore,
  RunFilter,
  RunPatch,
  RunStore,
  RunSummary,
  SqliteRunStoreOptions,
  StateStore,
} from './run-store.js'
export { NotImplementedError, PostgresRunStore } from './run-store-postgres.js'
export type { PostgresRunStoreOptions } from './run-store-postgres.js'
export { WorkspaceManager } from './workspace.js'
export type {
  PreparedWorkspace,
  WorkspaceManagerOptions,
  WorkspaceMetadata,
  WorkspaceSummary,
} from './workspace.js'
export type { WorkspaceWriteOptions } from './types.js'
export {
  ALL_AGENTMEMORY_OPS,
  ALL_PERMISSION_DIMENSIONS,
  createPolicyFetch,
  intersectResolvedPolicies,
  resolvePermissions,
  TrustEnforcer,
} from './permissions.js'
export { buildSystemPrompt, buildSystemPromptFromRequest } from './system-prompt.js'
export type { SystemPromptInput, BuildFromRequestContext } from './system-prompt.js'
export type {
  AgentmemoryOperation,
  AgentmemoryPolicy,
  AgentPermissions,
  ApprovalPolicy,
  EnforceDecision,
  NetworkPolicy,
  PermissionDenialReason,
  PermissionDimension,
  ResolvedAgentmemoryPolicy,
  ResolvedPolicy,
  ResolvedToolMatcher,
  ResolvePermissionsOptions,
  ToolMatcher,
} from './permissions.js'
export type { RunHandle, RunOptions, WaitRequest } from './runner.js'
export {
  ApprovalDeniedError,
  BackendChainExhaustedError,
  runPipeline,
  Runner,
  SchemaValidationError,
} from './runner.js'
export { extractJsonFromText } from './json-utils.js'
export { validate } from './schema.js'
export type { SkelmSchema } from './schema.js'
export { formatSkillBlock, parseSkill, SkillParseError } from './skills.js'
export type { Skill } from './skills.js'
export { createConcurrencySemaphore } from './concurrency.js'
export type { ConcurrencySemaphore } from './concurrency.js'
export { timingSafeStringEqual } from './crypto.js'
export { loadSkillBodies } from './skill-injection.js'
export { assertEgressEnforceable } from './egress-enforcement.js'
export { isMetadataAddress } from './net-classify.js'
export { combineSignals, timeoutSignal } from './signals.js'
export { AgentDefinitionError, loadAgentDefinition } from './agent-def.js'
export type { AgentDefinition, LoadAgentDefinitionOptions } from './agent-def.js'

// Enforcement seams owned by the gateway in production
export {
  AutoApproveGate,
  AutoDenyGate,
  EnvSecretResolver,
  MissingSecretError,
  NoopAuditWriter,
  PermissionResolver,
} from './enforcement/index.js'
export type {
  ApprovalDecision,
  ApprovalGate,
  ApprovalRequest,
  AuditEvent,
  AuditWriter,
  PermissionResolverOptions,
  SecretResolver,
} from './enforcement/index.js'
export type {
  AgentStep,
  AssetHost,
  BranchStep,
  CodeStep,
  Context,
  ForEachStep,
  InvokeStep,
  InferStep,
  LoopStep,
  ParallelOnError,
  ParallelStep,
  ParallelWaitFor,
  Pipeline,
  PipelineStep,
  PipelineTrigger,
  RetryPolicy,
  Run,
  RunId,
  RunMetadata,
  RunStatus,
  RunWaiting,
  SerializedError,
  Step,
  StepId,
  StepKind,
  StepResult,
  StepStatus,
  WaitStep,
  WhenPredicate,
  ExecFn,
} from './types.js'
export { createThreadHost } from './threads.js'
export type { Thread, ThreadHost, ThreadRef } from './threads.js'
export type {
  ExecRequest,
  ExecResult,
} from './types.js'
export { loadTsModule, pickExport, clearTsModuleCache } from './ts-loader.js'
export type { LoadTsModuleOptions } from './ts-loader.js'
