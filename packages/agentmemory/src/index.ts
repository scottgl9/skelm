// Public surface of @skelm/agentmemory.

export {
  AgentmemoryConfigSchema,
  DEFAULT_AGENTMEMORY_BASE_PATH,
} from './config.js'
export type { AgentmemoryConfig, AgentmemoryConfigInput } from './config.js'

export { AgentmemoryClient } from './client.js'
export type { AgentmemoryClientOptions } from './client.js'

export { AgentmemoryError, AgentmemoryConfigError } from './errors.js'

export { createAgentmemoryHandle } from './handle.js'
export type {
  AgentmemoryAuditEvent,
  AgentmemoryHandleOptions,
  AgentmemoryRuntimeEvent,
} from './handle.js'

export {
  deriveSessionId,
  endMemoryTurn,
  extractPromptText,
  recordMemoryTurn,
  startMemoryTurn,
} from './lifecycle.js'
export type { MemoryTurnInit, MemoryTurnRecord, MemoryTurnResult } from './lifecycle.js'

export type {
  AgentmemoryHookType,
  ContextRequest,
  ContextResponse,
  GraphEdge,
  GraphNode,
  GraphQueryRequest,
  GraphQueryResponse,
  HealthResponse,
  HookPayload,
  MemoryRecallRequest,
  MemoryRecallResponse,
  MemorySaveRequest,
  MemorySaveResponse,
  SessionEndRequest,
  SessionStartRequest,
  SessionsListRequest,
  SessionsListResponse,
  SessionSummary,
  SmartSearchHit,
  SmartSearchRequest,
  SmartSearchResponse,
} from './types.js'
