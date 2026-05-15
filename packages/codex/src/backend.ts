import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  SkelmBackend,
} from '@skelm/core'
import type { CodexBackendOptions } from './types.js'

/**
 * SkelmBackend for OpenAI Codex, driven by the official `@openai/codex-sdk`.
 *
 * Surfaces the full skelm feature set against Codex:
 *
 *   - MCP servers injected through `CodexOptions.config.mcp_servers`.
 *   - Skills concatenated into the system prompt before each turn.
 *   - Permissions translated to Codex sandbox + approval modes.
 *   - Streaming events relayed via `BackendContext.onPartial`.
 *   - Session resumption via `Codex.resumeThread`.
 *   - Cancellation via the SDK's per-turn `signal: AbortSignal`.
 *
 * Permission enforcement is `'wrapped'`: Codex enforces its own sandbox
 * in-process; skelm enforces at the boundary (pre-run refusal, workspace
 * pinning, egress proxy envelope, post-event audit).
 */
export function createCodexBackend(options: CodexBackendOptions = {}): SkelmBackend {
  const capabilities: BackendCapabilities = {
    prompt: false,
    streaming: true,
    sessionLifecycle: true,
    mcp: true,
    skills: true,
    modelSelection: options.model !== undefined,
    toolPermissions: 'wrapped',
  }

  const backend: SkelmBackend = {
    id: options.id ?? 'codex',
    capabilities,
    ...(options.label !== undefined && { label: options.label }),

    async run(_request: AgentRequest, _context: BackendContext): Promise<AgentResponse> {
      throw new Error(
        '@skelm/codex run() not yet implemented — wire-up lands in a follow-up commit',
      )
    },
  }

  return backend
}
