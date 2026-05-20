// Pi coding agent backend for skelm.
//
// Uses pi's RPC mode (pi --mode rpc) for agent steps. One pi process is
// kept alive per backend instance (like @skelm/opencode), with a
// concurrency semaphore to avoid spawning unlimited processes.
//
// Pi does NOT speak ACP; this backend uses the native pi RPC protocol
// documented in @mariozechner/pi-coding-agent/docs/rpc.md.

import {
  PermissionDeniedError,
  createConcurrencySemaphore,
  extractPromptText,
  loadSkillBodies,
} from '@skelm/core'
import type {
  AgentPermissions,
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
 *
 * @param options Backend configuration
 * @param options.egressProxyUrl Optional egress proxy URL to inject into subprocess
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
    // mid-run, so it cannot enforce allowedTools, allowedExecutables,
    // fsRead/fsWrite, allowedMcpServers, or allowedSkills. The new gateway
    // egress proxy DOES enforce networkEgress out-of-band (HTTP_PROXY +
    // SKELM_EGRESS_TOKEN), but that is orthogonal to *tool* permissions. We
    // therefore keep toolPermissions: 'unsupported' and refuse below when a
    // caller hands us a non-network-only policy (defense-in-depth).
    toolPermissions: 'unsupported',
  }

  const { acquire, release } = createConcurrencySemaphore(options.maxConcurrent ?? 4)

  return {
    id: options.id ?? 'pi',
    label: options.label ?? 'Pi Coding Agent',
    capabilities,

    async run(request: AgentRequest, context: BackendContext): Promise<AgentResponse> {
      const policy = context.permissions ?? request.permissions
      // Defense-in-depth: Pi RPC cannot enforce tool / executable /
      // filesystem / MCP / skill permissions inside the pi subprocess. We
      // refuse when the workflow *explicitly declared* one of those
      // dimensions. networkEgress alone is fine because the gateway egress
      // proxy enforces it out-of-band, and a fully-defaulted policy
      // (everything intersected to the deny-all empty set, e.g. from
      // project defaults) is policy resolution — not user intent.
      //
      // When `declaredPermissions` is supplied (the canonical runner path)
      // we use it directly; otherwise fall back to inspecting the resolved
      // policy so callers that hand-build a ResolvedPolicy still get the
      // refusal.
      const refuse =
        context.declaredPermissions !== undefined
          ? declaresNonNetworkDimension(context.declaredPermissions)
          : policy !== undefined && resolvedPolicyHasNonNetworkConstraints(policy)
      if (refuse) {
        throw new PermissionDeniedError(
          'pi RPC backend cannot enforce tool, executable, filesystem, MCP, or skill permissions in-subprocess. Use the pi-sdk backend for tool-level enforcement, or remove those dimensions and rely on networkEgress + the gateway egress proxy.',
        )
      }
      await acquire()

      const client = new PiRpcClient({
        command: options.command ?? 'pi',
        ...(options.provider !== undefined && { provider: options.provider }),
        ...(options.model !== undefined && { model: options.model }),
        ...((request.cwd ?? options.cwd) !== undefined && { cwd: request.cwd ?? options.cwd }),
        ...(options.egressProxyUrl !== undefined && { egressProxyUrl: options.egressProxyUrl }),
        ...(context.egressToken !== undefined && { egressToken: context.egressToken }),
        // Per-step proxy env from the runtime (canonical path; takes precedence
        // over options.egressProxyUrl).
        ...(context.proxyEnv !== undefined && { proxyEnv: context.proxyEnv }),
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
 * True iff the workflow author explicitly declared at least one non-network
 * dimension on the step. Walks the raw `AgentPermissions` input, NOT the
 * resolved `ResolvedPolicy` (which always has every dimension populated by
 * intersection — so we cannot tell user intent from defaulted deny-all).
 */
/**
 * Fallback for callers that don't populate `BackendContext.declaredPermissions`
 * (older test harnesses, hand-built ResolvedPolicy instances). Mirrors the
 * pre-`declaredPermissions` heuristic: any non-default shape on a non-network
 * dimension counts as a constraint Pi RPC cannot enforce.
 */
function resolvedPolicyHasNonNetworkConstraints(policy: {
  allowedTools?: { exact: ReadonlySet<string>; prefixes: readonly string[]; star: boolean }
  allowedExecutables?: ReadonlySet<string>
  allowedMcpServers?: ReadonlySet<string>
  allowedSkills?: ReadonlySet<string>
  fsRead?: ReadonlySet<string>
  fsWrite?: ReadonlySet<string>
  approval?: unknown
}): boolean {
  const tools = policy.allowedTools
  if (tools !== undefined && !tools.star) return true
  if (policy.allowedExecutables !== undefined && policy.allowedExecutables.size === 0) return true
  if (policy.allowedMcpServers !== undefined && policy.allowedMcpServers.size === 0) return true
  if (policy.allowedSkills !== undefined && policy.allowedSkills.size === 0) return true
  if (policy.fsRead !== undefined && policy.fsRead.size === 0) return true
  if (policy.fsWrite !== undefined && policy.fsWrite.size === 0) return true
  if (policy.approval !== undefined && policy.approval !== null) return true
  return false
}

function declaresNonNetworkDimension(declared: AgentPermissions | undefined): boolean {
  if (declared === undefined) return false
  return (
    declared.allowedTools !== undefined ||
    declared.deniedTools !== undefined ||
    declared.allowedExecutables !== undefined ||
    declared.allowedMcpServers !== undefined ||
    declared.allowedSkills !== undefined ||
    declared.allowedSecrets !== undefined ||
    declared.fsRead !== undefined ||
    declared.fsWrite !== undefined ||
    declared.approval !== undefined ||
    declared.profile !== undefined
  )
}

function buildPrompt(req: AgentRequest, skillBodies: string[] = []): string {
  const parts: string[] = []
  const systemParts: string[] = []
  if (req.agentDef?.soul !== undefined) systemParts.push(req.agentDef.soul)
  if (req.agentDef !== undefined) systemParts.push(req.agentDef.instructions)
  if (req.system) systemParts.push(req.system)
  for (const body of skillBodies) systemParts.push(body)
  if (systemParts.length > 0) parts.push(`[System: ${systemParts.join('\n\n---\n\n')}]`)
  parts.push(extractPromptText(req.prompt))
  return parts.join('\n\n')
}
