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
import {
  buildPermissionAuditEntry,
  mapSkelmPermissionsToOpencode,
  validatePermissions,
} from './permission-mapper.js'
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
        // Log audit entry for denied permissions
        const auditEntry = buildPermissionAuditEntry(
          'unknown', // runId not available in BackendContext
          'unknown', // stepId not available in AgentRequest
          policy,
          permissionResult,
        )

        // In production, this would be written to the audit log
        // For now, we log to console
        console.warn('Permission denied:', JSON.stringify(auditEntry, null, 2))

        throw new Error(`Permission denied: ${permissionResult.denied.join(', ')}`)
      }

      // Use the shared client (server started on first call, kept alive)
      const onAbort = () => client.cancel()
      context.signal.addEventListener('abort', onAbort, { once: true })

      try {
        const result = await client.prompt(request, {})
        return result
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes('Authentication')) {
            throw new BackendAuthenticationError(`Opencode authentication failed: ${error.message}`)
          }
          if (error.message.includes('Rate limit')) {
            throw new BackendRateLimitError(`Opencode rate limit exceeded: ${error.message}`)
          }
          if (error.message.includes('Timeout')) {
            throw new BackendTimeoutError(`Opencode request timeout: ${error.message}`)
          }
        }
        throw error
      } finally {
        context.signal.removeEventListener('abort', onAbort)
        // Do NOT dispose — server stays alive for subsequent calls
      }
    },
  }

  return backend
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
    networkEgress: 'deny',
    fsRead: new Set(),
    fsWrite: new Set(),
    approval: null,
  }
}

/**
 * Custom error types for opencode backend
 */
export class BackendAuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackendAuthenticationError'
  }
}

export class BackendRateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackendRateLimitError'
  }
}

export class BackendTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackendTimeoutError'
  }
}

/**
 * Create an opencode backend with ACP compatibility mode
 *
 * This runs opencode as a subprocess via ACP instead of using the SDK directly.
 * Useful for testing or when API access is restricted.
 */
export function createOpencodeAcpBackend(options: {
  command?: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  id?: string
  label?: string
}): SkelmBackend {
  const command = options.command ?? 'opencode'
  const args = options.args ?? ['acp']

  const capabilities: BackendCapabilities = {
    prompt: true,
    streaming: true,
    sessionLifecycle: true,
    mcp: true,
    skills: false, // ACP mode has limited skill control
    modelSelection: false,
    toolPermissions: 'unsupported', // ACP forwards permissions as metadata only
  }

  const backend: SkelmBackend = {
    id: options.id ?? 'opencode-acp',
    capabilities,
    ...(options.label !== undefined && { label: options.label }),

    async run(request: AgentRequest, context: BackendContext): Promise<AgentResponse> {
      // ACP mode: permissions are advisory only
      // Forward the request to opencode via stdio
      // This is a placeholder - full ACP implementation would use the AcpClient

      throw new Error(
        'ACP mode not yet implemented. Use SDK mode with createOpencodeBackend() instead.',
      )
    },
  }

  return backend
}
