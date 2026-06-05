import { PermissionDeniedError } from './errors.js'
import type { ResolvedPolicy } from './permissions.js'

/**
 * In-process backends (vercel-ai, pi, …) cannot intercept globalThis.fetch
 * to honor the gateway egress proxy. Per the project tenet "a backend that
 * cannot enforce a declared permission fails at step start instead of
 * bypassing it", any policy that constrains networkEgress to something other
 * than 'allow' is refused up-front.
 *
 * Subprocess backends (opencode) do not call this — the gateway egress
 * proxy injects HTTP_PROXY into the child.
 */
export function assertEgressEnforceable(
  policy: ResolvedPolicy | undefined,
  backendName: string,
): void {
  if (policy === undefined) return
  if (policy.networkEgress === 'allow') return
  throw new PermissionDeniedError(
    `${backendName} backend cannot enforce networkEgress in-process. Set networkEgress: "allow" for this step, or use a subprocess backend (opencode) so the gateway egress proxy can intercept outbound traffic.`,
  )
}
