/**
 * Named role bundles. A role is a friendly name for a fixed set of scopes;
 * a token's effective scopes are the union of its roles' scopes and its own
 * explicit scopes. Roles never grant more than `*:*` (Owner).
 *
 * Roles are intentionally coarse. Fine-grained access is expressed by
 * attaching explicit scopes to a token in addition to (or instead of) a role.
 */

import type { Scope } from './scopes.js'

export const ROLE_NAMES = [
  'Owner',
  'Admin',
  'Operator',
  'Developer',
  'Auditor',
  'Approver',
  'Viewer',
  'ServiceAccount',
] as const

export type RoleName = (typeof ROLE_NAMES)[number]

// Read-only scope across the resources a human operator inspects.
const READ_SCOPES: Scope[] = [
  'gateway:read',
  'project:read',
  'workflow:read',
  'run:read',
  'schedule:read',
  'trigger:read',
  'approval:read',
  'secret:read',
  'integration:read',
  'state:read',
  'artifact:read',
  'task:read',
  'package:read',
]

const ROLE_SCOPES: Readonly<Record<RoleName, readonly Scope[]>> = {
  // Full control, including token administration.
  Owner: ['*:*'],
  // Everything except being the literal root: broad management without the
  // `*:*` bypass. Includes admin token management.
  Admin: [
    ...READ_SCOPES,
    'admin:*',
    'workflow:*',
    'project:*',
    'run:*',
    'schedule:*',
    'trigger:*',
    'approval:*',
    'secret:*',
    'integration:*',
    'state:*',
    'artifact:*',
    'task:*',
    'package:*',
    'gateway:configure',
    'audit:read',
    'audit:export',
  ],
  // Day-to-day run/schedule operation; no secret rotation, no admin.
  Operator: [
    ...READ_SCOPES,
    'run:run',
    'run:start',
    'run:cancel',
    'run:resume',
    'schedule:edit',
    'trigger:edit',
    'task:run',
    'task:cancel',
    'approval:approve',
    'approval:deny',
  ],
  // Authors and publishes workflows/packages; runs them.
  Developer: [
    ...READ_SCOPES,
    'workflow:edit',
    'workflow:publish',
    'workflow:run',
    'workflow:start',
    'package:install',
    'package:update',
    'package:remove',
    'run:run',
    'run:start',
    'run:cancel',
    'run:resume',
    'task:run',
  ],
  // Read everything plus export audit; nothing mutating.
  Auditor: [...READ_SCOPES, 'audit:read', 'audit:export'],
  // Acts on approval gates only (plus the reads needed to see them).
  Approver: ['run:read', 'approval:read', 'approval:approve', 'approval:deny'],
  // Pure read.
  Viewer: [...READ_SCOPES],
  // Headless runner: triggers/runs workflows, no human-review or admin powers.
  ServiceAccount: [
    'workflow:read',
    'workflow:run',
    'workflow:start',
    'run:read',
    'run:run',
    'run:start',
    'run:resume',
    'trigger:read',
    'task:read',
    'task:run',
  ],
}

/** True when `name` is one of the known roles. */
export function isRoleName(name: string): name is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(name)
}

/** Scopes granted by a single role. Unknown roles contribute nothing. */
export function scopesForRole(name: string): readonly Scope[] {
  return isRoleName(name) ? ROLE_SCOPES[name] : []
}

/**
 * Effective scopes for a token: the de-duplicated union of every role's scopes
 * and the token's explicit scopes.
 */
export function effectiveScopes(roles: readonly string[], scopes: readonly Scope[]): Scope[] {
  const out = new Set<Scope>()
  for (const role of roles) {
    for (const s of scopesForRole(role)) out.add(s)
  }
  for (const s of scopes) out.add(s)
  return [...out]
}
