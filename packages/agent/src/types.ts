/**
 * Type alias for the backend returned by createSkelmAgentBackend.
 *
 * Implements:
 * - `infer()` — single-shot LLM inference (infer steps)
 * - `run()` — multi-turn agent loop with built-in tools (agent steps)
 *
 * Capabilities:
 * - prompt: true
 * - streaming: false
 * - sessionLifecycle: true when a `sessionStore` is configured, else false
 * - mcp: true (delegates MCP tools to attached McpHost)
 * - skills: true (wraps skillSource with canLoadSkill enforcement)
 * - modelSelection: true
 * - toolPermissions: 'native' (enforces all permissions in-process)
 */

export interface SkelmAgentBackendCapabilities {
  prompt: true
  streaming: false
  sessionLifecycle: boolean
  mcp: true
  skills: true
  modelSelection: true
  toolPermissions: 'native'
}
