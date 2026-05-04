// @skelm/gateway
//
// The skelm gateway is the long-running process that owns the trust boundary,
// configuration, registries (workflows / skills / MCP servers / agents),
// agent process lifecycle, audit, and the HTTP/SSE surface.

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
  type GatewayRegistries,
  type GatewayState,
  type LockfileContents,
  LockfileError,
  readDiscovery,
  readLockfile,
  releaseLockfile,
  removeDiscovery,
  writeDiscovery,
} from './lifecycle/index.js'

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
  WorkflowRegistry,
  type WorkflowEntry,
  type WorkflowRegistryOptions,
  walkGlob,
} from './registries/index.js'
