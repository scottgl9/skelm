/**
 * Egress policy evaluation for the embedded CONNECT proxy.
 *
 * Each agent step registers a token → policy entry before the subprocess
 * starts.  The proxy resolves the token from the Proxy-Authorization header
 * and calls `evaluate()` to decide whether to allow or deny a connection.
 */

export type NetworkPolicy = 'allow' | 'deny' | { allowHosts: readonly string[] }

export interface EgressPolicy {
  networkEgress: NetworkPolicy
  runId?: string
  stepId?: string
}

export type EgressDecision =
  | { allow: true }
  | { allow: false; reason: 'egress-denied' | 'not-in-allowlist' | 'no-policy' }

/**
 * Evaluate whether `host` is allowed under `policy`.
 */
export function evaluate(policy: EgressPolicy, host: string): EgressDecision {
  const egress = policy.networkEgress

  if (egress === 'deny') {
    return { allow: false, reason: 'egress-denied' }
  }

  if (egress === 'allow') {
    return { allow: true }
  }

  // { allowHosts: [...] }
  const allowed = egress.allowHosts.some((h) => matchHost(h, host))
  if (allowed) return { allow: true }
  return { allow: false, reason: 'not-in-allowlist' }
}

/**
 * Exact hostname match or leading-wildcard match (*.example.com).
 */
function matchHost(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) // '.example.com'
    return host === pattern.slice(2) || host.endsWith(suffix)
  }
  return host === pattern
}

/**
 * In-memory token registry.  Thread-safe for single-threaded Node.js.
 */
export class EgressPolicyRegistry {
  private readonly entries = new Map<string, EgressPolicy>()

  register(token: string, policy: EgressPolicy): void {
    this.entries.set(token, policy)
  }

  revoke(token: string): void {
    this.entries.delete(token)
  }

  resolve(token: string): EgressPolicy | undefined {
    return this.entries.get(token)
  }
}
