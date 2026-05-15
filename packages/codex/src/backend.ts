import { loadSkillBodies } from '@skelm/core'
import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  McpServerConfig,
  SkelmBackend,
} from '@skelm/core'

import {
  buildCodexOptions,
  buildMcpServerConfig,
  buildThreadOptions,
  consumeStream,
  makeCodexClient,
} from './client.js'
import { mapPermissionsToCodex } from './permission-mapper.js'
import type { CodexBackendOptions } from './types.js'

/**
 * SkelmBackend for OpenAI Codex via the official `@openai/codex-sdk`.
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

    async run(request: AgentRequest, context: BackendContext): Promise<AgentResponse> {
      const policy = request.permissions ?? context.permissions
      if (policy === undefined) {
        throw new Error('codex backend requires a resolved permission policy')
      }

      // Boundary check + sandbox/approval translation. Throws on refusal.
      const mapped = mapPermissionsToCodex({
        policy,
        ...(request.cwd !== undefined && { workingDirectory: request.cwd }),
      })

      // Filter requested MCP servers through the allowlist.
      const allowed = filterAllowedMcp(request.mcpServers, policy.allowedMcpServers)
      const mcpConfig = buildMcpServerConfig(allowed.allowed)
      const deniedMcp = allowed.denied.map((s) => s.id)
      if (deniedMcp.length > 0) {
        // Audit-only: surface in console for now; the runner's audit writer
        // is the durable record.
        // biome-ignore lint/suspicious/noConsole: pre-audit-bus surface
        console.warn(
          JSON.stringify({
            event: 'permission.denied',
            dimension: 'mcp',
            ids: deniedMcp,
            backend: 'codex',
          }),
        )
      }

      // Construct the SDK client with config + proxy env.
      const codexOpts = buildCodexOptions(options, {
        ...(context.proxyEnv !== undefined && { env: context.proxyEnv }),
        ...(mcpConfig !== null && { config: mcpConfig }),
      })
      const codex = makeCodexClient(codexOpts)

      // Compose the system prompt: agentDef + step.system + skill bodies.
      const systemPrompt = await composeSystemPrompt(request, context)
      const userPrompt =
        systemPrompt === undefined ? request.prompt : `${systemPrompt}\n\n---\n\n${request.prompt}`

      // Build the thread (resume vs fresh) honoring per-step sandbox/approval.
      const threadOpts = buildThreadOptions(options, {
        sandboxMode: mapped.sandboxMode,
        approvalPolicy: mapped.approvalPolicy,
        networkAccessEnabled: mapped.networkAccessEnabled,
        ...(mapped.workingDirectory !== undefined && {
          workingDirectory: mapped.workingDirectory,
        }),
        ...(mapped.additionalDirectories !== undefined && {
          additionalDirectories: mapped.additionalDirectories,
        }),
      })

      const sessionId = readSessionId(request)
      const thread =
        sessionId !== undefined
          ? codex.resumeThread(sessionId, threadOpts)
          : codex.startThread(threadOpts)

      // Drive the turn. The SDK honors the abort signal natively.
      const { events } = await thread.runStreamed(userPrompt, {
        ...(request.outputSchema !== undefined && { outputSchema: request.outputSchema }),
        signal: context.signal,
      })

      const result = await consumeStream(events, {
        ...(context.onPartial !== undefined && { onText: context.onPartial }),
      })

      const response: AgentResponse = {
        text: result.finalText,
        stopReason: result.stopReason,
      }
      if (result.usage !== undefined) {
        response.usage = {
          ...(result.usage.inputTokens !== undefined && { inputTokens: result.usage.inputTokens }),
          ...(result.usage.outputTokens !== undefined && {
            outputTokens: result.usage.outputTokens,
          }),
          ...(result.usage.reasoningTokens !== undefined && {
            reasoningTokens: result.usage.reasoningTokens,
          }),
        }
      }
      return response
    },
  }

  return backend
}

function filterAllowedMcp(
  servers: readonly McpServerConfig[] | undefined,
  allowlist: ReadonlySet<string>,
): { allowed: McpServerConfig[]; denied: McpServerConfig[] } {
  if (servers === undefined || servers.length === 0) return { allowed: [], denied: [] }
  const allowed: McpServerConfig[] = []
  const denied: McpServerConfig[] = []
  for (const s of servers) {
    if (allowlist.has(s.id)) allowed.push(s)
    else denied.push(s)
  }
  return { allowed, denied }
}

async function composeSystemPrompt(
  req: AgentRequest,
  ctx: BackendContext,
): Promise<string | undefined> {
  const parts: string[] = []
  if (req.agentDef?.soul !== undefined) parts.push(req.agentDef.soul)
  if (req.agentDef !== undefined) parts.push(req.agentDef.instructions)
  if (req.system !== undefined) parts.push(req.system)
  const skillBodies = await loadSkillBodies(req, ctx)
  parts.push(...skillBodies)
  if (parts.length === 0) return undefined
  return parts.join('\n\n---\n\n')
}

/**
 * AgentRequest doesn't have a typed sessionId field at the moment, but
 * runners may attach one through structural typing. Read defensively.
 */
function readSessionId(request: AgentRequest): string | undefined {
  const sid = (request as { sessionId?: unknown }).sessionId
  return typeof sid === 'string' && sid.length > 0 ? sid : undefined
}
