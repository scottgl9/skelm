import { runWithMemoryTurns } from '@skelm/agentmemory'
import {
  BackendAuthenticationError,
  BackendRateLimitError,
  BackendTimeoutError,
  PermissionDeniedError,
  loadSkillBodies,
  resolvePermissions,
} from '@skelm/core'
import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  McpServerConfig,
  SkelmBackend,
} from '@skelm/core'
import { OpencodeClientWrapper } from './client.js'
import { mapSkelmPermissionsToOpencode, validatePermissions } from './permission-mapper.js'
import type { OpencodeBackendOptions } from './types.js'

/**
 * SkelmBackend implementation for opencode.ai with full permission enforcement
 *
 * This backend enforces permissions at the skelm layer BEFORE forwarding
 * to opencode, ensuring we maintain complete control over:
 * - Command line execution (bash, executables)
 * - MCP server access
 * - File system operations
 * - Tool and skill usage
 */
export function createOpencodeBackend(options: OpencodeBackendOptions): SkelmBackend {
  const capabilities: BackendCapabilities = {
    // Opencode is an agent runtime (subprocess); it does not implement
    // single-shot `inference()`. Like ACP, advertise prompt:false so the
    // backend-contract gate stays consistent with the actual surface.
    prompt: false,
    streaming: true,
    sessionLifecycle: true,
    mcp: true,
    skills: true,
    modelSelection: options.model !== undefined,
    toolPermissions: 'native',
    // Image content is threaded into opencode as a `FilePartInput` alongside
    // the text part (see buildOpencodePromptParts in client.ts); whether the
    // *upstream* model actually processes images depends on the configured
    // opencode model (Sonnet, GPT-4o, etc. — see opencode docs). Set
    // `vision: false` via the second capability block above if a deployment
    // pins a known text-only model.
    vision: options.vision ?? true,
    // run() wires the agentmemory turn lifecycle (startMemoryTurn /
    // recordMemoryTurn / endMemoryTurn). Required for the runtime
    // capability gate to allow agentmemory-permitted steps to dispatch here.
    agentmemory: true,
  }

  // Single client instance per backend — server started on first call and
  // kept alive for subsequent calls (one session per prompt call).
  const client = new OpencodeClientWrapper(options)

  const backend: SkelmBackend = {
    id: options.id ?? 'opencode',
    capabilities,
    ...(options.label !== undefined && { label: options.label }),

    async run(request: AgentRequest, context: BackendContext): Promise<AgentResponse> {
      // Validate permissions at skelm layer BEFORE forwarding to opencode
      const policy =
        context.permissions ?? request.permissions ?? resolvePermissions(undefined, undefined)

      const permissionResult = validatePermissions(policy, {
        // We don't have direct access to requested tools in AgentRequest
        // This would be determined during tool execution
        executables: [],
        ...(request.mcpServers !== undefined && {
          mcpServers: request.mcpServers.map((m) => m.id),
        }),
      })

      if (!permissionResult.allowed) {
        // Throw the typed error so the runner's audit writer (the single
        // durable record) captures the denial; no parallel console log.
        throw new PermissionDeniedError(
          `opencode: permission denied: ${permissionResult.denied.join(', ')}`,
        )
      }

      const memoryProject = request.cwd ?? process.cwd()
      // Load skills and inject into system prompt before forwarding
      const enrichedRequest = await injectSkills(request, context)

      // Signal and timeout are threaded directly into prompt(); no separate
      // cancel() listener needed — the SSE loop handles abort internally.
      try {
        return await runWithMemoryTurns<AgentResponse>(
          {
            handle: context.agentmemory,
            ...(context.runId !== undefined && { runId: context.runId }),
            ...(context.stepId !== undefined && { stepId: context.stepId }),
            project: memoryProject,
          },
          request,
          async ({ recallPrefix }) => {
            const memoryEnrichedRequest =
              recallPrefix.length > 0
                ? {
                    ...enrichedRequest,
                    system:
                      enrichedRequest.system === undefined
                        ? recallPrefix
                        : `${recallPrefix}${enrichedRequest.system}`,
                  }
                : enrichedRequest
            const result = await client.prompt(
              memoryEnrichedRequest,
              context.signal,
              options.timeout,
              policy,
              context.onPartial,
            )
            return { result, resultText: result.text ?? '' }
          },
        )
      } catch (error) {
        if (error instanceof Error) {
          // The opencode SDK surfaces these conditions as plain Errors
          // with descriptive messages; substring matching is the only
          // signal available. The original error is attached as `cause`
          // so callers retain stack and any provider-specific fields.
          if (error.message.includes('Authentication')) {
            throw new BackendAuthenticationError(
              `Opencode authentication failed: ${error.message}`,
              'opencode',
              { cause: error },
            )
          }
          if (error.message.includes('Rate limit')) {
            throw new BackendRateLimitError(
              `Opencode rate limit exceeded: ${error.message}`,
              'opencode',
              { cause: error },
            )
          }
          if (error.message.includes('timed out')) {
            throw new BackendTimeoutError(error.message, 'opencode', { cause: error })
          }
        }
        throw error
      }
      // Do NOT dispose — server stays alive for subsequent calls
    },

    async dispose(): Promise<void> {
      await client.dispose()
    },
  }

  return backend
}

async function injectSkills(req: AgentRequest, ctx: BackendContext): Promise<AgentRequest> {
  const prefixParts: string[] = []
  if (req.agentDef?.soul !== undefined) prefixParts.push(req.agentDef.soul)
  if (req.agentDef !== undefined) prefixParts.push(req.agentDef.instructions)
  const skillParts = await loadSkillBodies(req, ctx)
  if (prefixParts.length === 0 && skillParts.length === 0) return req
  const systemParts: string[] = [...prefixParts]
  if (req.system !== undefined) systemParts.push(req.system)
  systemParts.push(...skillParts)
  return { ...req, system: systemParts.join('\n\n---\n\n') }
}
