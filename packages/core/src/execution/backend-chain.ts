import {
  type AgentRequest,
  type AgentResponse,
  type BackendCapabilities,
  BackendCapabilityError,
  type BackendContext,
  type BackendId,
  BackendNotFoundError,
  type BackendRegistry,
  type InferenceRequest,
  type InferenceResponse,
  type SkelmBackend,
} from '../backend.js'
import { BackendChainExhaustedError } from '../errors.js'

// Capability dimensions every member of a fallback chain must share. The
// agent/infer handlers run their fail-closed gates (vision, mcp, skills,
// agentmemory, permission enforcement) against the resolved backend's
// capabilities and wire runtime support (mcpHost, egress) from them. A chain is
// surfaced to the handler as ONE backend whose capabilities are member[0]'s, so
// every member must declare the same capabilities — otherwise a fallover could
// hand the turn to a backend that can't honor a permission the gate already
// cleared. We therefore reject a heterogeneous chain at step start (fail closed,
// per tenet #1) rather than silently weaken enforcement on fallover.
const CHAIN_CAPABILITY_KEYS: readonly (keyof BackendCapabilities)[] = [
  'prompt',
  'streaming',
  'sessionLifecycle',
  'mcp',
  'skills',
  'modelSelection',
  'toolPermissions',
  'vision',
  'agentmemory',
]

/**
 * Resolve a step's `backend` field (a single id, an ordered fallback list, or
 * undefined) to one {@link SkelmBackend}. A list becomes a fallover wrapper that
 * tries each backend in order and throws {@link BackendChainExhaustedError} once
 * all fail; a single id / undefined resolves exactly as before.
 */
export function resolveBackendForStep(
  backends: BackendRegistry,
  stepId: string,
  spec: string | readonly string[] | undefined,
  kind: 'llm' | 'agent',
): SkelmBackend {
  const resolveOne = (id: BackendId | undefined): SkelmBackend =>
    kind === 'llm'
      ? backends.resolveForLlm({ backendId: id })
      : backends.resolveForAgent({ backendId: id })

  if (!Array.isArray(spec)) {
    return resolveOne(spec as string | undefined)
  }
  if (spec.length === 0) {
    throw new BackendNotFoundError(`step "${stepId}" declares an empty backend chain`)
  }
  // Resolving each id validates capability per member (prompt+inference for
  // llm, run for agent) and surfaces a typed error for an unregistered id.
  const chain = spec.map((id) => resolveOne(id))
  if (chain.length === 1) {
    // biome-ignore lint/style/noNonNullAssertion: length checked above
    return chain[0]!
  }
  return createStepFallbackBackend(stepId, chain)
}

/**
 * Wrap an ordered, capability-homogeneous list of backends as a single backend
 * that fails over on error. Exported for tests; the handlers reach it through
 * {@link resolveBackendForStep}.
 */
export function createStepFallbackBackend(
  stepId: string,
  chain: readonly SkelmBackend[],
): SkelmBackend {
  // biome-ignore lint/style/noNonNullAssertion: callers pass a non-empty chain
  const first = chain[0]!
  for (let i = 1; i < chain.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded by length
    const member = chain[i]!
    for (const key of CHAIN_CAPABILITY_KEYS) {
      if (member.capabilities[key] !== first.capabilities[key]) {
        throw new BackendCapabilityError(
          `step "${stepId}" backend chain is not capability-homogeneous: "${first.id}" and "${member.id}" differ on capability "${key}". Every backend in a step-level fallback chain must declare identical capabilities so the step's permission, MCP, vision, and agentmemory gates hold for whichever backend serves the turn.`,
          member.id,
          key,
        )
      }
    }
  }

  const tryEach = async <T>(call: (b: SkelmBackend) => Promise<T>): Promise<T> => {
    const attempts: { backendId: string; cause: unknown }[] = []
    for (const backend of chain) {
      try {
        return await call(backend)
      } catch (err) {
        attempts.push({ backendId: backend.id, cause: err })
      }
    }
    throw new BackendChainExhaustedError(stepId, attempts)
  }

  const wrapper: SkelmBackend = {
    id: chain.map((b) => b.id).join('+'),
    capabilities: { ...first.capabilities },
    async dispose(): Promise<void> {
      await Promise.all(chain.map((b) => b.dispose?.()))
    },
  }
  if (typeof first.inference === 'function') {
    wrapper.inference = (req: InferenceRequest, ctx: BackendContext): Promise<InferenceResponse> =>
      // biome-ignore lint/style/noNonNullAssertion: homogeneous chain — all share prompt+inference
      tryEach((b) => b.inference!(req, ctx))
  }
  if (typeof first.run === 'function') {
    wrapper.run = (req: AgentRequest, ctx: BackendContext): Promise<AgentResponse> =>
      // biome-ignore lint/style/noNonNullAssertion: homogeneous chain — all share run
      tryEach((b) => b.run!(req, ctx))
  }
  return wrapper
}
