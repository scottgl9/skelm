/**
 * Scope model for gateway RBAC.
 *
 * A scope is a `resource:action` pair. Both halves may be the literal `*`
 * wildcard. Three concrete shapes exist:
 *   - `resource:action` — grants exactly one action on one resource
 *   - `resource:*`       — grants every action on one resource
 *   - `*:*`              — root; grants everything (the legacy single token)
 *
 * Scope satisfaction is a superset test: a *granted* scope satisfies a
 * *required* scope when the granted resource is `*` or equal, AND the granted
 * action is `*` or equal. There is no implicit hierarchy beyond the wildcard —
 * `workflow:edit` does not imply `workflow:read`; roles bundle the read scope
 * explicitly where that is intended.
 */

export const RESOURCES = [
  'gateway',
  'project',
  'workflow',
  'run',
  'schedule',
  'trigger',
  'approval',
  'secret',
  'integration',
  'state',
  'artifact',
  'audit',
  'admin',
  'package',
  'task',
] as const

export type Resource = (typeof RESOURCES)[number]

export const ACTIONS = [
  'read',
  'run',
  'start',
  'cancel',
  'resume',
  'approve',
  'deny',
  'edit',
  'publish',
  'install',
  'update',
  'remove',
  'configure',
  'rotate',
  'export',
  'administer',
] as const

export type Action = (typeof ACTIONS)[number]

/** A `resource:action` string. Either half may be `*`. */
export type Scope = string

const RESOURCE_SET: ReadonlySet<string> = new Set<string>(RESOURCES)
const ACTION_SET: ReadonlySet<string> = new Set<string>(ACTIONS)

/**
 * Validate a scope string. A scope is `<res>:<act>` where `<res>` is a known
 * resource or `*`, and `<act>` is a known action or `*`. Used at the system
 * boundary (admin token-create) so malformed scopes are rejected before they
 * are persisted.
 */
export function isValidScope(scope: string): boolean {
  const idx = scope.indexOf(':')
  if (idx <= 0 || idx !== scope.lastIndexOf(':')) return false
  const resource = scope.slice(0, idx)
  const action = scope.slice(idx + 1)
  if (resource.length === 0 || action.length === 0) return false
  const resourceOk = resource === '*' || RESOURCE_SET.has(resource)
  const actionOk = action === '*' || ACTION_SET.has(action)
  return resourceOk && actionOk
}

/**
 * Does a single granted scope satisfy a single required scope?
 *
 * `granted` may use `*` on either half; `required` is always a concrete
 * `resource:action`. Returns true when granted's resource is `*` or equal AND
 * granted's action is `*` or equal.
 */
export function scopeSatisfies(granted: Scope, required: Scope): boolean {
  const gIdx = granted.indexOf(':')
  const rIdx = required.indexOf(':')
  if (gIdx <= 0 || rIdx <= 0) return false
  const gRes = granted.slice(0, gIdx)
  const gAct = granted.slice(gIdx + 1)
  const rRes = required.slice(0, rIdx)
  const rAct = required.slice(rIdx + 1)
  const resOk = gRes === '*' || gRes === rRes
  const actOk = gAct === '*' || gAct === rAct
  return resOk && actOk
}

/** Does any scope in `granted` satisfy the `required` scope? */
export function scopesSatisfy(granted: readonly Scope[], required: Scope): boolean {
  for (const g of granted) {
    if (scopeSatisfies(g, required)) return true
  }
  return false
}

/** True when the scope set contains root (`*:*`), bypassing every scope check. */
export function isRootScopes(granted: readonly Scope[]): boolean {
  return granted.includes('*:*')
}
