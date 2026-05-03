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
