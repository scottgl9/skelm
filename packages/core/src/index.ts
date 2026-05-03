// Public surface of @skelm/core. Anything exported from this file is part
// of the public API; anything not re-exported here is internal.

export const VERSION = '0.1.0'

export * from './acp/index.js'
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
  llm,
  loop,
  parallel,
  pipeline,
  pipelineStep,
} from './builders.js'
export { RunCancelledError, StepError, serializeError } from './errors.js'
export { EventBus, terminalEventTypeFor } from './events.js'
export type { EventListener, RunEvent, RunEventType } from './events.js'
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
export type { RunOptions } from './runner.js'
export { runPipeline, SchemaValidationError } from './runner.js'
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
} from './types.js'
