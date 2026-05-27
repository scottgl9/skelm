import { PermissionDeniedError, loadSkillBodies } from '@skelm/core'
import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  McpServerConfig,
  ResolvedPolicy,
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
    prompt: true,
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
      const policy = context.permissions ?? request.permissions ?? createEmptyPolicy()

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

      // Load skills and inject into system prompt before forwarding
      const enrichedRequest = await injectSkills(request, context)

      // Signal and timeout are threaded directly into prompt(); no separate
      // cancel() listener needed — the SSE loop handles abort internally.
      try {
        const result = await client.prompt(
          enrichedRequest,
          context.signal,
          options.timeout,
          policy,
          context.onPartial,
        )
        return result
      } catch (error) {
        if (error instanceof Error) {
          // The opencode SDK surfaces these conditions as plain Errors
          // with descriptive messages; substring matching is the only
          // signal available. The original error is attached as `cause`
          // so callers retain stack and any provider-specific fields.
          if (error.message.includes('Authentication')) {
            throw new BackendAuthenticationError(
              `Opencode authentication failed: ${error.message}`,
              { cause: error },
            )
          }
          if (error.message.includes('Rate limit')) {
            throw new BackendRateLimitError(`Opencode rate limit exceeded: ${error.message}`, {
              cause: error,
            })
          }
          if (error.message.includes('timed out')) {
            throw new BackendTimeoutError(error.message, { cause: error })
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

/**
 * Create an empty policy for when no permissions are specified
 */
function createEmptyPolicy(): ResolvedPolicy {
  return {
    allowedTools: {
      exact: new Set(),
      prefixes: [],
      star: false,
    },
    deniedTools: {
      exact: new Set(),
      prefixes: [],
      star: false,
    },
    allowedExecutables: new Set(),
    allowedMcpServers: new Set(),
    allowedSkills: new Set(),
    allowedSecrets: new Set(),
    networkEgress: 'deny',
    fsRead: new Set(),
    fsWrite: new Set(),
    approval: null,
    agentmemory: {
      allowObserve: false,
      allowSearch: false,
      allowSession: false,
      allowContext: false,
    },
  }
}

/**
 * Custom error types for opencode backend
 */
export class BackendAuthenticationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BackendAuthenticationError'
  }
}

export class BackendRateLimitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BackendRateLimitError'
  }
}

export class BackendTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BackendTimeoutError'
  }
}
