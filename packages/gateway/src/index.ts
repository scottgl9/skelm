// Public surface of @skelm/gateway — the long-running process that owns the
// trust boundary: config, registries, agent lifecycle, audit, and HTTP/SSE.

export const GATEWAY_PACKAGE_VERSION = '0.2.0'

// HTTP / SSE surface (formerly @skelm/server)
export type { AuthMode, ServerConfig } from './http/config.js'
export { createServer } from './http/server.js'
export type { SkelmServer } from './http/types.js'

// Lifecycle
export {
  acquireLockfile,
  type DiscoveryRecord,
  Gateway,
  type GatewayOptions,
  type GatewayEnforcement,
  type GatewayManagers,
  type GatewayRegistries,
  type GatewayState,
  type LockfileContents,
  LockfileError,
  isProcessAlive,
  readDiscovery,
  readLockfile,
  releaseLockfile,
  removeDiscovery,
  writeDiscovery,
} from './lifecycle/index.js'

// Audit + secrets
export { ChainAuditWriter } from './audit/chain.js'
export type {
  AuditExportFormat,
  ChainEntry,
  PruneBoundary,
  PruneResult,
} from './audit/chain.js'
export {
  FileAuditSink,
  ForwardingAuditWriter,
  HttpAuditSink,
  buildAuditSinks,
} from './audit/forwarder.js'
export type { AuditSink } from './audit/forwarder.js'

// Operational logs (distinct from audit + run events)
export { FileLogSink, RingBufferLogSink, TeeLogSink, redact } from './logs/sink.js'
export type { LogEntry, LogSink } from './logs/sink.js'
export { FileSecretResolver } from './secrets/file-driver.js'
export { VaultNotImplementedError, VaultSecretResolver } from './secrets/vault-driver.js'
export type { VaultSecretResolverOptions } from './secrets/vault-driver.js'

// Approval gate
export { SuspendApprovalGate } from './approvals/suspend-gate.js'
export type { PendingApproval, SuspendApprovalGateOptions } from './approvals/suspend-gate.js'
export {
  HitlResolutionError,
  auditHitl,
  buildDecision,
  getPendingHitl,
  hitlAuditEvent,
  listPendingHitl,
} from './hitl/hitl-service.js'
export type { HitlResolution, PendingHitlGate } from './hitl/hitl-service.js'

// Debug / breakpoints
export { BreakpointRegistry } from './debug/breakpoint-registry.js'
export type { PausedRun } from './debug/breakpoint-registry.js'

// Process supervisors
export { McpServerManager } from './managers/mcp-server-manager.js'
export type {
  McpServerHandle,
  McpServerManagerOptions,
  McpServerStatus,
} from './managers/mcp-server-manager.js'
export {
  AcpSessionManager,
  defaultAcpSessionStorePath,
} from './managers/acp-session-manager.js'
export type {
  AcpSession,
  AcpSessionManagerOptions,
  AcpSessionState,
  CreateSessionOptions,
} from './managers/acp-session-manager.js'
export { CodingAgentManager } from './managers/coding-agent-manager.js'

// Trigger coordinator + dispatcher
export { TriggerCoordinator } from './triggers/coordinator.js'
export type {
  PollDedupeKeyFn,
  PollSourceFn,
  TriggerCoordinatorOptions,
} from './triggers/coordinator.js'
export { InMemoryQueueDriver } from './triggers/queue-driver.js'
export type { QueueDriver } from './triggers/queue-driver.js'
export { createTriggerDispatcher } from './triggers/dispatcher.js'
export type { CreateDispatcherOptions, WorkflowLoader } from './triggers/dispatcher.js'
export { pipelineTriggerToSpec } from './triggers/pipeline-trigger-to-spec.js'
export type {
  FireContext,
  OverlapPolicy,
  RunCallback,
  TriggerRegistration as GatewayTriggerRegistration,
  TriggerSpec,
} from './triggers/types.js'
export type {
  CodingAgentHandle,
  CodingAgentManagerOptions,
  CodingAgentStatus,
  EphemeralRun,
  ResidentHandle,
} from './managers/coding-agent-manager.js'

// Registries
export {
  AgentRegistry,
  type AgentEntry,
  type AgentRegistryOptions,
  BaseRegistry,
  FsWatcher,
  type FsWatchOptions,
  McpServerRegistry,
  type McpServerEntry,
  type McpServerRegistryOptions,
  type Registry,
  type RegistryChange,
  type RegistryListener,
  SkillRegistry,
  type SkillRegistryOptions,
  createSkillSource,
  type CreateSkillSourceOptions,
  WorkflowRegistry,
  type WorkflowEntry,
  type WorkflowRegistryOptions,
  walkGlob,
} from './registries/index.js'
