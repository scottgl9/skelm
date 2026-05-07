/**
 * Egress policy checking logic for the CONNECT proxy.
 *
 * Maps `networkEgress` permission values to allow/deny decisions:
 * - `'deny'` → reject all
 * - `'allow'` → forward all
 * - `{ allowHosts: [...] }` → forward only listed hostnames
 */

import type { NetworkPolicy } from '@skelm/core'

/**
 * Result of a policy check.
 */
export interface PolicyCheckResult {
  allowed: boolean
  reason?: 'egress-denied' | 'not-in-allowlist' | 'unknown-token'
}

/**
 * Token-to-policy mapping. Each agent step run gets a unique token
 * that maps to its resolved networkEgress policy.
 */
export interface TokenPolicyMap {
  get(token: string): NetworkPolicy | undefined
  set(token: string, policy: NetworkPolicy): void
  delete(token: string): void
}

/**
 * In-memory token-to-policy store.
 */
export class InMemoryTokenPolicyStore implements TokenPolicyMap {
  private store = new Map<string, NetworkPolicy>()

  get(token: string): NetworkPolicy | undefined {
    return this.store.get(token)
  }

  set(token: string, policy: NetworkPolicy): void {
    this.store.set(token, policy)
  }

  delete(token: string): void {
    this.store.delete(token)
  }
}

/**
 * Check if a hostname is allowed by the given network policy.
 *
 * @param policy The network egress policy
 * @param hostname The destination hostname
 * @returns PolicyCheckResult indicating allow/deny
 */
export function checkHostPolicy(policy: NetworkPolicy, hostname: string): PolicyCheckResult {
  if (policy === 'deny') {
    return { allowed: false, reason: 'egress-denied' }
  }

  if (policy === 'allow') {
    return { allowed: true }
  }

  // policy is { allowHosts: readonly string[] }
  if (policy.allowHosts.includes(hostname)) {
    return { allowed: true }
  }

  return { allowed: false, reason: 'not-in-allowlist' }
}

/**
 * Extract hostname from a CONNECT request target.
 *
 * CONNECT targets are in the form `hostname:port` (e.g., `api.openai.com:443`)
 */
export function extractHostnameFromConnectTarget(target: string): string {
  const colonIndex = target.lastIndexOf(':')
  if (colonIndex === -1) {
    // No port specified, treat entire target as hostname
    return target
  }
  return target.slice(0, colonIndex)
}

/**
 * Extract hostname from an HTTP request Host header.
 */
export function extractHostnameFromHostHeader(hostHeader: string): string {
  // Host header can be "hostname" or "hostname:port"
  const colonIndex = hostHeader.lastIndexOf(':')
  if (colonIndex === -1) {
    return hostHeader
  }
  return hostHeader.slice(0, colonIndex)
}
