/**
 * Pi coding agent SDK backend for skelm.
 *
 * Unlike the RPC backend (which spawns `pi --mode rpc` and cannot intercept
 * individual tool calls), this backend uses the pi SDK directly, allowing
 * skelm to pass a hard tool allowlist that pi enforces natively.
 *
 * System prompt strategy:
 *   By default pi's coding-agent system prompt is kept active. req.system
 *   and skill blocks are appended after it so the agent has full context.
 *   Set options.systemPrompt to replace pi's base prompt entirely.
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

      try {
        const policy = context.permissions ?? request.permissions
        const toolAllowlist = derivePiToolAllowlist(policy)

        const skillBodies = await loadSkillBodies(request, context)
        const systemContent = buildSystemContent(options.systemPrompt, request, skillBodies)

        const cwd = request.cwd ?? options.cwd
        const client = new PiSdkClient({
          ...(cwd !== undefined && { cwd }),
          ...(toolAllowlist !== undefined && { tools: toolAllowlist }),
          ...(policy !== undefined && toolAllowlist?.length === 0 && { noTools: 'all' as const }),
          ...(options.noExtensions !== undefined && { noExtensions: options.noExtensions }),
          ...(options.noSkills !== undefined && { noSkills: options.noSkills }),
          ...(options.noContextFiles !== undefined && { noContextFiles: options.noContextFiles }),
          // System prompt: inject content and indicate whether to replace pi's base
          ...(systemContent !== undefined && {
            system: systemContent,
            replaceSystemPrompt: options.systemPrompt !== undefined,
          }),
        })

        const result = await client.prompt(
          request.prompt,
          context.signal,
          options.timeout ?? 300_000,
        )

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

  const execs = policy.allowedExecutables
  if (execs.has('bash') || execs.has('sh')) {
    allowed.push('bash')
  }

  const fsRead = policy.fsRead
  if (fsRead instanceof Set ? fsRead.size > 0 : Array.isArray(fsRead) && fsRead.length > 0) {
    allowed.push('read', 'grep', 'find', 'ls')
  }

  const fsWrite = policy.fsWrite
  if (fsWrite instanceof Set ? fsWrite.size > 0 : Array.isArray(fsWrite) && fsWrite.length > 0) {
    if (!allowed.includes('read')) allowed.push('read', 'grep', 'find', 'ls')
    allowed.push('write', 'edit')
  }

  return allowed
}

/**
 * Assemble the system content to inject into pi's system prompt.
 *
 * When systemBase is set it replaces pi's prompt; req.system and skills are
 * always appended so the agent has the step's context regardless of mode.
 */
function buildSystemContent(
  systemBase: string | undefined,
  req: AgentRequest,
  skillBodies: string[],
): string | undefined {
  const parts: string[] = []
  if (systemBase !== undefined) parts.push(systemBase)
  if (req.agentDef?.soul !== undefined) parts.push(req.agentDef.soul)
  if (req.agentDef !== undefined) parts.push(req.agentDef.instructions)
  if (req.system) parts.push(req.system)
  for (const body of skillBodies) parts.push(body)
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined
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
