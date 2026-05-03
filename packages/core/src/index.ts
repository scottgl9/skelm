// Public surface of @skelm/core. Anything exported from this file is part
// of the public API; anything not re-exported here is internal.

export const VERSION = '0.0.0'

export {
  BackendCapabilityError,
  BackendNotFoundError,
  BackendRegistry,
} from './backend.js'
export type {
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
export { branch, code, forEach, llm, loop, parallel, pipeline } from './builders.js'
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
