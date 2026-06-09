/**
 * Shared permission fixture helpers for unit and adversarial tests.
 *
 * Import from `../../src/testing/permissions.js` in core tests that exercise
 * TrustEnforcer behaviour. Keeps test files focused on what they are asserting
 * rather than on wiring the enforcer.
 */
import { TrustEnforcer, resolvePermissions } from '../permissions.js'
import type { AgentPermissions } from '../permissions.js'

export type { AgentPermissions }

/**
 * Build a TrustEnforcer from a defaults + step permission pair.
 * Sugar for `new TrustEnforcer(resolvePermissions(defaults, step))`.
 */
export function makeEnforcer(
  defaults: Parameters<typeof resolvePermissions>[0],
  step: Parameters<typeof resolvePermissions>[1],
): TrustEnforcer {
  return new TrustEnforcer(resolvePermissions(defaults, step))
}
