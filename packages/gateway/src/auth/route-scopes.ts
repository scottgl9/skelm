/**
 * Route → required-scope map for gateway RBAC.
 *
 * Every non-exempt HTTP route on the control surface (and the server's own
 * /pipelines + /runs routes) declares the `resource:action` scope a scoped
 * token must hold to reach it. Read routes map to `<resource>:read`; writes map
 * to the specific action.
 *
 * Default-deny: a non-exempt route that is NOT in this map is denied to any
 * non-root scoped token. Root tokens (`*:*`, including the legacy single token)
 * bypass the map entirely. Exempt routes (health/version) are open.
 *
 * Matching is method + path, with `:param` segments matching one path segment.
 * Entries are evaluated in order; the first method+path match wins, so more
 * specific paths are listed before their prefixes.
 */

import type { Scope } from './scopes.js'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

interface RouteScopeEntry {
  method: HttpMethod
  /** Compiled from a path template with `:param` placeholders. */
  pattern: RegExp
  scope: Scope
}

/** Paths that never require auth/scopes (liveness/readiness/metrics probes). */
const EXEMPT: ReadonlyArray<{ method: HttpMethod; path: string }> = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/healthz' },
  { method: 'GET', path: '/readyz' },
  { method: 'GET', path: '/metrics' },
]

function templateToRegExp(path: string): RegExp {
  // Escape regex metachars, then turn `:name` segments into a single-segment
  // capture. Trailing slash optional. Anchored both ends.
  const escaped = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) return '[^/]+'
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return new RegExp(`^${escaped}/?$`)
}

// Method + path-template → scope. Order matters: list specific paths before
// their prefixes so the first match is the most specific.
const ROUTE_SCOPE_TABLE: ReadonlyArray<{ method: HttpMethod; path: string; scope: Scope }> = [
  // ── gateway lifecycle / config / runtime ────────────────────────────────
  { method: 'POST', path: '/gateway/pause', scope: 'gateway:configure' },
  { method: 'POST', path: '/gateway/resume', scope: 'gateway:configure' },
  { method: 'POST', path: '/gateway/reload', scope: 'gateway:configure' },
  { method: 'GET', path: '/config', scope: 'gateway:read' },
  { method: 'GET', path: '/v1/config', scope: 'gateway:read' },
  { method: 'PATCH', path: '/v1/config', scope: 'gateway:configure' },
  { method: 'GET', path: '/v1/dashboard/runtime', scope: 'gateway:read' },

  // ── admin token management ───────────────────────────────────────────────
  { method: 'POST', path: '/v1/admin/tokens', scope: 'admin:administer' },
  { method: 'GET', path: '/v1/admin/tokens', scope: 'admin:administer' },
  { method: 'POST', path: '/v1/admin/tokens/:id/revoke', scope: 'admin:administer' },

  // ── debug surface ────────────────────────────────────────────────────────
  { method: 'GET', path: '/debug/breakpoints', scope: 'gateway:read' },
  { method: 'POST', path: '/debug/breakpoints', scope: 'gateway:configure' },
  { method: 'DELETE', path: '/debug/breakpoints/:stepId', scope: 'gateway:configure' },
  { method: 'GET', path: '/debug/runs', scope: 'run:read' },
  { method: 'POST', path: '/debug/runs/:runId/release', scope: 'run:resume' },

  // ── pipelines ──────────────────────────────────────────────────────────-
  { method: 'POST', path: '/pipelines/:id/run', scope: 'workflow:run' },
  { method: 'POST', path: '/pipelines/:id/start', scope: 'workflow:start' },
  { method: 'POST', path: '/pipelines/run-file', scope: 'workflow:run' },
  { method: 'POST', path: '/pipelines/start-file', scope: 'workflow:start' },
  { method: 'POST', path: '/pipelines/describe-file', scope: 'workflow:read' },
  { method: 'GET', path: '/pipelines/:id', scope: 'workflow:read' },
  { method: 'GET', path: '/pipelines', scope: 'workflow:read' },

  // ── runs ──────────────────────────────────────────────────────────────-
  { method: 'POST', path: '/runs/:runId/approve', scope: 'approval:approve' },
  { method: 'POST', path: '/runs/:runId/deny', scope: 'approval:deny' },
  { method: 'POST', path: '/runs/:runId/resume', scope: 'run:resume' },
  { method: 'GET', path: '/runs/:runId/events', scope: 'run:read' },
  { method: 'GET', path: '/runs/:runId/stream', scope: 'run:read' },
  { method: 'GET', path: '/runs/:runId/artifacts/:artifactId', scope: 'artifact:read' },
  { method: 'GET', path: '/runs/:runId/artifacts', scope: 'artifact:read' },
  { method: 'DELETE', path: '/runs/:runId', scope: 'run:cancel' },
  { method: 'GET', path: '/runs/:runId', scope: 'run:read' },
  { method: 'POST', path: '/runs', scope: 'run:run' },
  { method: 'GET', path: '/runs', scope: 'run:read' },

  // ── approvals ──────────────────────────────────────────────────────────-
  { method: 'GET', path: '/approvals', scope: 'approval:read' },

  // ── batch ──────────────────────────────────────────────────────────────-
  { method: 'POST', path: '/v1/batch/runs', scope: 'run:run' },
  { method: 'POST', path: '/v1/batch/cancel', scope: 'run:cancel' },

  // ── chat / openai ────────────────────────────────────────────────────────
  { method: 'POST', path: '/v1/chat/completions', scope: 'workflow:run' },
  { method: 'POST', path: '/v1/responses', scope: 'workflow:run' },
  { method: 'POST', path: '/v1/chat/:sourceId/submit', scope: 'workflow:run' },

  // ── audit ──────────────────────────────────────────────────────────────-
  { method: 'GET', path: '/audit/verify', scope: 'audit:read' },
  { method: 'GET', path: '/audit', scope: 'audit:read' },

  // ── triggers / schedules ─────────────────────────────────────────────────
  { method: 'GET', path: '/triggers', scope: 'trigger:read' },
  { method: 'POST', path: '/triggers/:id/fire', scope: 'trigger:run' },
  { method: 'GET', path: '/schedules/:id', scope: 'schedule:read' },
  { method: 'GET', path: '/schedules', scope: 'schedule:read' },
  { method: 'POST', path: '/schedules', scope: 'schedule:edit' },
  { method: 'DELETE', path: '/schedules/:id', scope: 'schedule:remove' },

  // ── sessions ───────────────────────────────────────────────────────────-
  { method: 'GET', path: '/sessions', scope: 'run:read' },
  { method: 'POST', path: '/sessions/:id/resume', scope: 'run:resume' },
  { method: 'POST', path: '/sessions/prune', scope: 'run:cancel' },
  { method: 'DELETE', path: '/sessions/:id', scope: 'run:cancel' },

  // ── state ──────────────────────────────────────────────────────────────-
  { method: 'GET', path: '/v1/state/:namespace/:key', scope: 'state:read' },
  { method: 'GET', path: '/v1/state/:namespace', scope: 'state:read' },

  // ── tasks / lineage ──────────────────────────────────────────────────────
  { method: 'GET', path: '/v1/tasks/:id/events', scope: 'task:read' },
  { method: 'POST', path: '/v1/tasks/:id/cancel', scope: 'task:cancel' },
  { method: 'POST', path: '/v1/tasks/:id/retry', scope: 'task:run' },
  { method: 'GET', path: '/v1/tasks/:id', scope: 'task:read' },
  { method: 'POST', path: '/v1/tasks', scope: 'task:run' },
  { method: 'GET', path: '/v1/tasks', scope: 'task:read' },
  { method: 'GET', path: '/v1/lineage/:runId', scope: 'run:read' },

  // ── agentmemory ──────────────────────────────────────────────────────────
  { method: 'GET', path: '/v1/agentmemory/status', scope: 'gateway:read' },
  { method: 'GET', path: '/v1/agentmemory/sessions', scope: 'gateway:read' },

  // ── packages ───────────────────────────────────────────────────────────-
  { method: 'POST', path: '/v1/packages/install', scope: 'package:install' },
  { method: 'POST', path: '/v1/packages/resolve', scope: 'package:read' },
  { method: 'GET', path: '/v1/packages/:name', scope: 'package:read' },
  { method: 'DELETE', path: '/v1/packages/:name', scope: 'package:remove' },
  { method: 'GET', path: '/v1/packages', scope: 'package:read' },

  // ── projects ───────────────────────────────────────────────────────────-
  { method: 'POST', path: '/v1/projects/activate', scope: 'project:configure' },
  { method: 'GET', path: '/v1/active', scope: 'project:read' },
  { method: 'POST', path: '/v1/workflows/:id/deactivate', scope: 'project:configure' },

  // ── workflows ──────────────────────────────────────────────────────────-
  { method: 'GET', path: '/v1/workflows/health', scope: 'workflow:read' },
  { method: 'POST', path: '/v1/workflows/validate', scope: 'workflow:read' },
  { method: 'POST', path: '/v1/workflows/register', scope: 'workflow:publish' },
  { method: 'GET', path: '/v1/workflows/:id/health', scope: 'workflow:read' },
  { method: 'GET', path: '/v1/workflows/:id/graph', scope: 'workflow:read' },
  { method: 'POST', path: '/v1/workflows/:id/source/apply', scope: 'workflow:edit' },
  { method: 'PUT', path: '/v1/workflows/:id', scope: 'workflow:edit' },
  { method: 'DELETE', path: '/v1/workflows/:id', scope: 'workflow:remove' },
  { method: 'GET', path: '/v1/workflows', scope: 'workflow:read' },

  // ── secrets ────────────────────────────────────────────────────────────-
  { method: 'GET', path: '/secrets/:name', scope: 'secret:read' },
  { method: 'PUT', path: '/secrets/:name', scope: 'secret:rotate' },
  { method: 'DELETE', path: '/secrets/:name', scope: 'secret:remove' },
  { method: 'GET', path: '/secrets', scope: 'secret:read' },

  // ── workspaces ───────────────────────────────────────────────────────────
  { method: 'GET', path: '/workspaces/:workflow/:name', scope: 'run:read' },
  { method: 'DELETE', path: '/workspaces/:workflow/:name', scope: 'run:cancel' },
  { method: 'GET', path: '/workspaces', scope: 'run:read' },

  // ── dashboard (read-only views) ──────────────────────────────────────────
  { method: 'GET', path: '/v1/dashboard/overview', scope: 'gateway:read' },
  { method: 'GET', path: '/v1/dashboard/workflows', scope: 'workflow:read' },
  { method: 'GET', path: '/v1/dashboard/runs', scope: 'run:read' },
  { method: 'GET', path: '/v1/dashboard/analytics', scope: 'gateway:read' },
  { method: 'GET', path: '/v1/dashboard/errors', scope: 'run:read' },
  { method: 'GET', path: '/v1/dashboard/schedules', scope: 'schedule:read' },
  { method: 'GET', path: '/v1/dashboard/approvals', scope: 'approval:read' },
]

const COMPILED: RouteScopeEntry[] = ROUTE_SCOPE_TABLE.map((e) => ({
  method: e.method,
  pattern: templateToRegExp(e.path),
  scope: e.scope,
}))

const COMPILED_EXEMPT: Array<{ method: HttpMethod; pattern: RegExp }> = EXEMPT.map((e) => ({
  method: e.method,
  pattern: templateToRegExp(e.path),
}))

/** True when the method+path is exempt from auth (open probe). */
export function isExemptRoute(method: string, path: string): boolean {
  const m = method.toUpperCase()
  for (const e of COMPILED_EXEMPT) {
    if (e.method === m && e.pattern.test(path)) return true
  }
  return false
}

/**
 * The required scope for a method+path, or `undefined` when the route is not in
 * the map. A non-exempt route with no mapping is denied to scoped tokens
 * (default-deny) — callers must treat `undefined` (for a non-exempt route) as
 * "deny", not "allow".
 */
export function requiredScopeFor(method: string, path: string): Scope | undefined {
  const m = method.toUpperCase()
  for (const e of COMPILED) {
    if (e.method === m && e.pattern.test(path)) return e.scope
  }
  return undefined
}
