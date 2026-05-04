/**
 * Permission mapping and validation for Pi backend
 */

import type { ResolvedPolicy, ResolvedToolMatcher } from '@skelm/core'
import type { MappedPermissions } from './types.js'

/**
 * Validate a request against the permission policy
 */
export function validatePermissions(
  policy: ResolvedPolicy,
  requested: string,
): { allowed: string[]; denied: string[] } {
  const allowed: string[] = []
  const denied: string[] = []

  // Check network egress
  if (
    policy.networkEgress === 'deny' &&
    (requested.includes('curl') || requested.includes('wget') || requested.includes('http'))
  ) {
    denied.push('network request')
  } else {
    allowed.push('network request')
  }

  // Check executables
  if (policy.allowedExecutables && policy.allowedExecutables.size > 0) {
    const hasWildcard = policy.allowedExecutables.has('*')
    if (!hasWildcard) {
      // Extract command from request
      const parts = requested.split(/\s+/)
      const command = parts[0]
      if (command !== undefined && !policy.allowedExecutables.has(command)) {
        denied.push(`executable: ${command}`)
      } else if (command !== undefined) {
        allowed.push(`executable: ${command}`)
      }
    }
  }

  // Check filesystem operations
  const isFsRead = /read|cat|head|tail|less|more|grep|sed|awk/.test(requested)
  const isFsWrite = /write|echo|tee|>|\|\|/.test(requested)

  if (isFsRead && policy.fsRead && policy.fsRead.size > 0 && !policy.fsRead.has('*')) {
    // Would need path analysis to validate
    allowed.push('fs read (unvalidated)')
  } else if (isFsRead) {
    allowed.push('fs read')
  }

  if (isFsWrite && policy.fsWrite && policy.fsWrite.size > 0 && !policy.fsWrite.has('*')) {
    denied.push('fs write (restricted)')
  } else if (isFsWrite) {
    allowed.push('fs write')
  }

  // Default allow if no restrictions
  if (denied.length === 0 && allowed.length === 0) {
    allowed.push('default')
  }

  return { allowed, denied }
}

/**
 * Build a permission audit entry for logging
 */
export function buildPermissionAuditEntry(
  runId: string,
  stepId: string,
  policy: ResolvedPolicy,
  result: { allowed: string[]; denied: string[] },
): Record<string, unknown> {
  return {
    type: 'permission-audit',
    runId,
    stepId,
    timestamp: new Date().toISOString(),
    policy: {
      networkEgress: policy.networkEgress,
      allowedExecutables: Array.from(policy.allowedExecutables),
      allowedTools: formatToolMatcher(policy.allowedTools),
      fsRead: Array.from(policy.fsRead),
      fsWrite: Array.from(policy.fsWrite),
    },
    result: {
      allowed: result.allowed,
      denied: result.denied,
      allAllowed: result.denied.length === 0,
    },
  }
}

/**
 * Format a tool matcher for display
 */
function formatToolMatcher(matcher: ResolvedToolMatcher): unknown {
  if (matcher.star) return ['*']
  const result: string[] = []
  if (matcher.exact.size > 0) {
    result.push(...Array.from(matcher.exact))
  }
  if (matcher.prefixes.length > 0) {
    result.push(...matcher.prefixes.map((p) => `${p}:prefix`))
  }
  return result
}
