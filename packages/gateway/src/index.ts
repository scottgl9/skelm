// @skelm/gateway
//
// The skelm gateway is the long-running process that owns the trust boundary,
// configuration, registries (workflows / skills / MCP servers / agents),
// agent process lifecycle, audit, and the HTTP/SSE surface.
//
// This entry point is intentionally empty in Phase 0; subsequent phases
// populate http/, lifecycle/, registries/, managers/, enforcement/, audit/,
// and scheduler/ submodules and re-export the public surface here.

export const GATEWAY_PACKAGE_VERSION = "0.2.0";
