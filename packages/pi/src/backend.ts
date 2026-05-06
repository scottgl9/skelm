// Pi coding agent backend for skelm.
//
// Uses pi's RPC mode (pi --mode rpc) for agent steps. One pi process is
// kept alive per backend instance (like @skelm/opencode), with a
// concurrency semaphore to avoid spawning unlimited processes.
//
// Pi does NOT speak ACP; this backend uses the native pi RPC protocol
// documented in @mariozechner/pi-coding-agent/docs/rpc.md.

import { PermissionDeniedError, formatSkillBlock } from '@skelm/core'
import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  SkelmBackend,
} from '@skelm/core'
import { PiRpcClient } from './rpc-client.js'
import type { PiBackendOptions } from './types.js'

/** Custom error types exposed from @skelm/pi */
export class PiBackendError extends Error {
  override readonly name = 'PiBackendError'
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}

export class PiBackendAuthenticationError extends PiBackendError {}
export class PiBackendRateLimitError extends PiBackendError {}
export class PiBackendTimeoutError extends PiBackendError {}

/**
 * Create a pi coding agent backend that delegates agent() steps to
 * `pi --mode rpc`.
 *
 * Each backend instance keeps one pi process alive and reuses it across
 * calls (a new session per call, same process). Use maxConcurrent to
 * limit simultaneous requests.
 */
export function createPiBackend(options: PiBackendOptions = {}): SkelmBackend {
  const capabilities: BackendCapabilities = {
    // RPC mode runs an agent loop; for single-shot inference (llm() steps)
    // use the pi-sdk backend which can disable tools via noTools: 'all'.
    prompt: false,
    streaming: true,
    sessionLifecycle: true,
    mcp: false, // pi manages its own tools; no external MCP wiring
    skills: true,
    modelSelection: options.model !== undefined,
    // RPC mode runs pi in a subprocess; skelm cannot intercept tool_call events
    // mid-run, so it cannot enforce allowedTools, networkEgress, fsRead/fsWrite,
    // or any other dimension. Declaring 'unsupported' makes the runner reject
    // steps that declare permissions, fail-closed, with an auditable event.
    // Workflows that need permission enforcement must use the pi-sdk backend.
    toolPermissions: 'unsupported',
  }

  // Concurrency semaphore — limits simultaneous pi processes
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
    id: options.id ?? 'pi',
    label: options.label ?? 'Pi Coding Agent',
    capabilities,

    async run(request: AgentRequest, context: BackendContext): Promise<AgentResponse> {
      const policy = context.permissions ?? request.permissions
      if (policy !== undefined) {
        // Defense in depth: the runner's capability check (toolPermissions:
        // 'unsupported') should already have rejected any step that declared
        // permissions. This guard catches paths that bypass that check
        // (e.g. backends invoked directly).
        throw new PermissionDeniedError(
          'pi RPC backend cannot enforce permission policies; use the pi-sdk backend instead',
        )
      }
      await acquire()

      const client = new PiRpcClient({
        command: options.command ?? 'pi',
        ...(options.provider !== undefined && { provider: options.provider }),
        ...(options.model !== undefined && { model: options.model }),
        ...((request.cwd ?? options.cwd) !== undefined && { cwd: request.cwd ?? options.cwd }),
        persistSession: false,
      })

      const onAbort = () => client.abort().catch(() => {})
      context.signal.addEventListener('abort', onAbort, { once: true })

      try {
        await client.start()

        const skillBodies = await loadSkillBodies(request, context)
        const prompt = buildPrompt(request, skillBodies)
        const result = await client.prompt(prompt, options.timeout ?? 300_000)

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
          if (err.message.includes('ENOENT') || err.message.includes('EACCES')) {
            throw new PiBackendAuthenticationError(
              'pi binary not found or not executable. Install it: npm install -g @mariozechner/pi-coding-agent',
              err,
            )
          }
          if (err.message.includes('timed out')) {
            throw new PiBackendTimeoutError(err.message, err)
          }
        }
        throw new PiBackendError(`pi agent execution failed: ${(err as Error).message}`, err)
      } finally {
        context.signal.removeEventListener('abort', onAbort)
        await client.stop()
        release()
      }
    },
  }
}

/**
 * Build the prompt string sent to pi, incorporating system prompt and
 * any multi-turn context from the request.
 */
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
  if (req.agentDef?.soul !== undefined) systemParts.push(req.agentDef.soul)
  if (req.agentDef !== undefined) systemParts.push(req.agentDef.instructions)
  if (req.system) systemParts.push(req.system)
  for (const body of skillBodies) systemParts.push(body)
  if (systemParts.length > 0) parts.push(`[System: ${systemParts.join('\n\n---\n\n')}]`)
  parts.push(req.prompt)
  return parts.join('\n\n')
}
