import {
  type ResolvedPolicy,
  TrustEnforcer,
  assertEgressEnforceable as assertEgressEnforceableCore,
} from '@skelm/core'
import type { Tool, ToolSet } from 'ai'

export function assertEgressEnforceable(policy: ResolvedPolicy | undefined): void {
  assertEgressEnforceableCore(policy, 'vercel-ai')
}

/**
 * Filter and wrap a user-supplied ToolSet so:
 *   1. Tools whose names are denied by the policy are removed entirely
 *      (model can't see or call them).
 *   2. Surviving tools have their `execute` re-checked at call time
 *      (defense-in-depth — even if filtering is bypassed, denial fires).
 *
 * When `policy === undefined`, returns an empty ToolSet (default-deny).
 */
export function applyPolicyToTools(
  tools: ToolSet | undefined,
  policy: ResolvedPolicy | undefined,
): ToolSet {
  if (tools === undefined || policy === undefined) return {}
  const enforcer = new TrustEnforcer(policy)
  const out: Record<string, unknown> = {}
  for (const [name, original] of Object.entries(tools)) {
    const decision = enforcer.canCallTool(name)
    if (!decision.allow) continue
    out[name] = wrapToolWithPolicy(name, original as Tool, enforcer)
  }
  return out as ToolSet
}

/**
 * Wrap a single tool so each call re-runs the policy check at call time.
 * Returns a denial result object the model can adapt to (rather than
 * throwing, which would terminate the entire generation).
 *
 * We rebuild the tool record explicitly rather than calling `tool()` —
 * passing the original through `tool()` wraps an already-wrapped object and
 * the overload union (execute vs outputSchema) confuses inference under
 * exactOptionalPropertyTypes.
 */
export function wrapToolWithPolicy(name: string, original: Tool, enforcer: TrustEnforcer): Tool {
  const orig = original as Record<string, unknown>
  const origExecute = orig.execute
  if (typeof origExecute !== 'function') return original

  const wrappedExecute = async (args: unknown, opts: unknown) => {
    const decision = enforcer.canCallTool(name)
    if (!decision.allow) {
      return {
        __skelmDenied: true as const,
        tool: name,
        reason: decision.reason,
        dimension: decision.dimension,
      }
    }
    return await (origExecute as (a: unknown, o: unknown) => unknown)(args, opts)
  }

  return { ...orig, execute: wrappedExecute } as unknown as Tool
}
