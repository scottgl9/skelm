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

export type {
  AgentmemoryHookType,
  ContextRequest,
  ContextResponse,
  HealthResponse,
  HookPayload,
  SessionEndRequest,
  SessionStartRequest,
  SmartSearchHit,
  SmartSearchRequest,
  SmartSearchResponse,
} from './types.js'
