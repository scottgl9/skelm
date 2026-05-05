/**
 * Pi coding agent SDK backend for skelm.
 *
 * Unlike the RPC backend (which spawns `pi --mode rpc` and cannot intercept
 * individual tool calls), this backend uses the pi SDK directly, allowing
 * skelm to pass a hard tool allowlist that pi enforces natively.
 *
 * Permission → tool mapping:
 *   allowedExecutables contains 'bash' or 'sh'  → 'bash'
 *   fsRead.size > 0                              → 'read', 'grep', 'find', 'ls'
 *   fsWrite.size > 0                             → 'write', 'edit'
 *   undefined policy                             → no override (pi defaults)
 */

import { formatSkillBlock } from '@skelm/core'
import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  ResolvedPolicy,
  SkelmBackend,
} from '@skelm/core'
import { PiSdkClient } from './sdk-client.js'
import type { PiSdkBackendOptions } from './types.js'

export class PiSdkBackendError extends Error {
  override readonly name = 'PiSdkBackendError'
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}

export class PiSdkBackendAuthenticationError extends PiSdkBackendError {}
export class PiSdkBackendTimeoutError extends PiSdkBackendError {}

/**
 * Create a pi coding agent backend using the pi SDK.
 *
 * This backend builds an explicit tool allowlist from the skelm permission
 * policy so pi itself enforces which tools the agent may use. This provides
 * native enforcement rather than the advisory enforcement of the RPC backend.
 */
export function createPiSdkBackend(options: PiSdkBackendOptions = {}): SkelmBackend {
  const capabilities: BackendCapabilities = {
    prompt: false,
    streaming: true,
    sessionLifecycle: true,
    mcp: false,
    skills: true,
    modelSelection: false,
    toolPermissions: 'native',
  }

  const maxConcurrent = options.maxConcurrent ?? 4
  let active = 0
  const queue: Array<() => void> = []

  const acquire = (): Promise<void> => {
    if (maxConcurrent === 0 || active < maxConcurrent) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => queue.push(resolve))
  }

  const release = () => {
    const next = queue.shift()
    if (next) next()
    else active--
  }

  return {
    id: options.id ?? 'pi-sdk',
    label: options.label ?? 'Pi Coding Agent (SDK)',
    capabilities,

    async run(request: AgentRequest, context: BackendContext): Promise<AgentResponse> {
      await acquire()

      const policy = context.permissions ?? request.permissions
      const toolAllowlist = derivePiToolAllowlist(policy)

      const client = new PiSdkClient({
        ...(options.cwd !== undefined || request.cwd !== undefined
          ? { cwd: request.cwd ?? options.cwd }
          : {}),
        ...(toolAllowlist !== undefined && { tools: toolAllowlist }),
        // When a policy is present but grants no tools, disable all built-ins
        ...(policy !== undefined && toolAllowlist?.length === 0 && { noTools: 'all' as const }),
      })

      try {
        const skillBodies = await loadSkillBodies(request, context)
        const prompt = buildPrompt(request, skillBodies)
        const result = await client.prompt(prompt, context.signal, options.timeout ?? 300_000)

        return {
          text: result.text,
          stopReason: result.stopReason,
          ...(result.usage !== undefined && {
            usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            },
          }),
        }
      } catch (err) {
        if (err instanceof Error) {
          if (err.message.includes('ENOENT') || err.message.includes('not installed')) {
            throw new PiSdkBackendAuthenticationError(
              'pi SDK not available. Install it: npm install @mariozechner/pi-coding-agent',
              err,
            )
          }
          if (err.message.includes('timed out')) {
            throw new PiSdkBackendTimeoutError(err.message, err)
          }
        }
        throw new PiSdkBackendError(`pi SDK agent execution failed: ${(err as Error).message}`, err)
      } finally {
        release()
      }
    },
  }
}

/**
 * Derive a pi tool allowlist from a skelm permission policy.
 *
 * Returns `undefined` when no policy is set (pi uses its defaults).
 * Returns a string[] (possibly empty) when a policy is present.
 */
export function derivePiToolAllowlist(policy: ResolvedPolicy | undefined): string[] | undefined {
  if (policy === undefined) return undefined

  const allowed: string[] = []

  // Shell/exec access
  const execs = policy.allowedExecutables
  if (execs.has('bash') || execs.has('sh')) {
    allowed.push('bash')
  }

  // Filesystem read access
  const fsRead = policy.fsRead
  if (fsRead instanceof Set ? fsRead.size > 0 : Array.isArray(fsRead) && fsRead.length > 0) {
    allowed.push('read', 'grep', 'find', 'ls')
  }

  // Filesystem write access (also enables read implicitly)
  const fsWrite = policy.fsWrite
  if (fsWrite instanceof Set ? fsWrite.size > 0 : Array.isArray(fsWrite) && fsWrite.length > 0) {
    if (!allowed.includes('read')) allowed.push('read', 'grep', 'find', 'ls')
    allowed.push('write', 'edit')
  }

  return allowed
}

async function loadSkillBodies(req: AgentRequest, ctx: BackendContext): Promise<string[]> {
  if (!req.skills || req.skills.length === 0 || !ctx.loadSkill) return []
  const bodies: string[] = []
  for (const skillId of req.skills) {
    const skill = await ctx.loadSkill(skillId)
    if (skill !== null) bodies.push(formatSkillBlock(skill))
  }
  return bodies
}

function buildPrompt(req: AgentRequest, skillBodies: string[] = []): string {
  const parts: string[] = []
  const systemParts: string[] = []
  if (req.system) systemParts.push(req.system)
  for (const body of skillBodies) systemParts.push(body)
  if (systemParts.length > 0) parts.push(`[System: ${systemParts.join('\n\n---\n\n')}]`)
  parts.push(req.prompt)
  return parts.join('\n\n')
}
