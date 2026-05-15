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
 * Permission enforcement is `'native'`: Codex enforces sandbox / approval /
 * network natively in its own process. Skelm validates at the boundary
 * (pre-run refusal, workspace pinning, egress proxy envelope, post-event
 * audit) — never widening what the policy permits.
 */
export function createCodexBackend(options: CodexBackendOptions = {}): SkelmBackend {
  const capabilities: BackendCapabilities = {
    prompt: false,
    streaming: true,
    sessionLifecycle: true,
    mcp: true,
    skills: true,
    modelSelection: options.model !== undefined,
    // Codex enforces sandbox / approval / network natively in its own process.
    // Skelm checks at the boundary (refusing unsafe combinations before any
    // Codex call); Codex enforces at runtime.
    toolPermissions: 'native',
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
      // Audit-only for now; the runner's audit writer is the durable record.
      // biome-ignore lint/suspicious/noConsole: pre-audit-bus surface
      const logDenial = (dimension: string, ids: string[], reason: string) =>
        console.warn(
          JSON.stringify({ event: 'permission.denied', dimension, ids, reason, backend: 'codex' }),
        )
      if (deniedMcp.length > 0) {
        logDenial('mcp', deniedMcp, 'not-in-allowlist')
      }
      if (mcpConfig !== null && mcpConfig.dropped.length > 0) {
        logDenial('mcp', mcpConfig.dropped, 'transport-unsupported')
      }

      // Construct the SDK client with config + proxy env. Only forward
      // `mcp_servers` to Codex — never leak the `dropped` bookkeeping field.
      const codexOpts = buildCodexOptions(options, {
        ...(context.proxyEnv !== undefined && { env: context.proxyEnv }),
        ...(mcpConfig !== null && { config: { mcp_servers: mcpConfig.mcp_servers } }),
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
        webSearchEnabled: mapped.webSearchEnabled,
        webSearchMode: mapped.webSearchMode,
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

      // Compose abort: the runner-supplied `context.signal` AND the
      // backend's `timeoutMs` (defensive ceiling). The SDK honors a single
      // AbortSignal on TurnOptions natively.
      const turnSignal = composeAbortSignal(context.signal, options.timeoutMs ?? 300_000)
      const { events } = await thread.runStreamed(userPrompt, {
        ...(request.outputSchema !== undefined && { outputSchema: request.outputSchema }),
        signal: turnSignal.signal,
      })

      let result: Awaited<ReturnType<typeof consumeStream>>
      try {
        result = await consumeStream(events, {
          ...(context.onPartial !== undefined && { onText: context.onPartial }),
        })
      } finally {
        turnSignal.cancel()
      }

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
 * TODO(@skelm/core): promote `sessionId?: string` to AgentRequest so this
 * cast goes away.
 */
function readSessionId(request: AgentRequest): string | undefined {
  const sid = (request as { sessionId?: unknown }).sessionId
  return typeof sid === 'string' && sid.length > 0 ? sid : undefined
}

/**
 * Compose the runner's signal with a backend-side timeout. The returned
 * signal aborts when either fires; `cancel()` clears the timer so a
 * successful run doesn't leak it.
 */
function composeAbortSignal(
  upstream: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  if (upstream.aborted) controller.abort(upstream.reason)
  const onAbort = () => controller.abort(upstream.reason)
  upstream.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new Error(`codex backend timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
      upstream.removeEventListener('abort', onAbort)
    },
  }
}
