// @skelm/gateway
//
// The skelm gateway is the long-running process that owns the trust boundary,
// configuration, registries (workflows / skills / MCP servers / agents),
// agent process lifecycle, audit, and the HTTP/SSE surface.
//
// Phase 1 absorbed the former @skelm/server package into ./http. Subsequent
// phases populate lifecycle/, registries/, managers/, enforcement/, audit/,
// and scheduler/ submodules.

export const GATEWAY_PACKAGE_VERSION = '0.2.0'

// HTTP / SSE surface (formerly @skelm/server)
export type { ServerConfig, AuthMode } from './http/config.js'
export { createServer } from './http/server.js'
export type { SkelmServer } from './http/types.js'
