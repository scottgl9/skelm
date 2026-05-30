import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'

// Intentionally narrow: only hot-reloadable, side-effect-bounded, non-security-relevant
// fields belong here. Auth, trust roots, secret-driver paths, and storage settings require
// a gateway restart so changes survive a reconcile and audit.
const ALLOWED_PATCH_PATHS = new Set<string>(['server.maxConcurrentRuns'])

/** Substrings (case-insensitive) that mark a field's value as sensitive. */
const SENSITIVE_KEYWORDS = ['token', 'secret', 'password', 'credential', 'key']

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_KEYWORDS.some((kw) => lower.includes(kw))
}

function redactMatchingKeys(record: Record<string, unknown>, skip: ReadonlySet<string>): void {
  for (const k of Object.keys(record)) {
    if (skip.has(k)) continue
    if (isSensitiveKey(k)) record[k] = '[redacted]'
  }
}

/**
 * Mount GET/PATCH /v1/config.
 *
 * GET returns a sanitized projection — no bearer tokens, no resolved
 * secret material. PATCH accepts a flat object whose keys must be in
 * ALLOWED_PATCH_PATHS; any other key returns 400. Applied changes go
 * through Gateway.reload() so existing infrastructure picks them up.
 */
export function registerConfigRoutes(router: Router, gateway: Gateway): void {
  router.get(
    '/v1/config',
    eventHandler(async () => sanitize(gateway.getConfig())),
  )

  router.patch(
    '/v1/config',
    eventHandler(async (event) => {
      const body = (await readBody(event).catch(() => ({}))) as Record<string, unknown>
      if (typeof body !== 'object' || body === null) {
        throw createError({ statusCode: 400, message: 'request body must be an object' })
      }
      const entries = Object.entries(body)
      if (entries.length === 0) {
        throw createError({ statusCode: 400, message: 'no fields to update' })
      }
      for (const [key] of entries) {
        if (!ALLOWED_PATCH_PATHS.has(key)) {
          throw createError({
            statusCode: 400,
            message: `field "${key}" is not hot-updatable; allowed: ${[...ALLOWED_PATCH_PATHS].join(', ')}`,
          })
        }
      }
      const current = gateway.getConfig()
      // Shallow copy with a fresh `server` branch — the only branch we
      // mutate here. Avoid structuredClone on `current` because backend
      // instances under `instances[]` / `backends.<id>` are live objects
      // with non-cloneable functions.
      const next = { ...current, server: { ...(current.server ?? {}) } } as typeof current
      for (const [key, value] of entries) {
        if (key === 'server.maxConcurrentRuns') {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
            throw createError({
              statusCode: 400,
              message: 'server.maxConcurrentRuns must be a positive number',
            })
          }
          ;(next.server as { maxConcurrentRuns?: number }).maxConcurrentRuns = value
        }
      }
      await gateway.reload(next)
      return { updated: true, config: sanitize(gateway.getConfig()) }
    }),
  )
}

/**
 * Drop token-like fields from every config branch the operator can put a
 * secret in: server.auth, secrets.file, the top-level env map, agents[].env,
 * mcpServers[].env, and top-level backend entries. The list grows by inclusion
 * — any new config branch that can hold credentials should run through the same
 * keyword scan.
 */
function sanitize(config: import('@skelm/core').SkelmConfig): Record<string, unknown> {
  // The runtime SkelmConfig can carry live backend instances (functions
  // closed over BackendContext) under `instances[]` and `backends.<id>`.
  // `structuredClone` throws DataCloneError on those — and the public
  // /v1/config response shouldn't expose them anyway. JSON round-trip
  // both deep-copies and strips the non-cloneable branches; everything
  // we redact below is pure data.
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>

  const server = (clone.server ?? {}) as Record<string, unknown>
  if (server.auth !== undefined && typeof server.auth === 'object' && server.auth !== null) {
    redactMatchingKeys(server.auth as Record<string, unknown>, new Set(['mode']))
  }

  // Secret driver paths are sensitive in some deployments — redact the file path.
  const secrets = (clone.secrets ?? {}) as Record<string, unknown>
  if (typeof secrets.file === 'string') secrets.file = '[redacted]'

  // The top-level `env` map is forwarded to backends and spawned subprocesses
  // and routinely holds credentials (e.g. OPENAI_API_KEY). It was previously
  // returned verbatim — every other env-bearing branch (agents/mcpServers/
  // backends) is scanned, but this one was missed, leaking secret values.
  const env = clone.env
  if (env !== null && typeof env === 'object') {
    redactMatchingKeys(env as Record<string, unknown>, new Set())
  }

  // registries.agents[].env and registries.mcpServers[].env can carry bearer
  // tokens / API keys forwarded to the spawned subprocess. Redact matching keys.
  const registries = clone.registries as Record<string, unknown> | undefined
  for (const listKey of ['agents', 'mcpServers'] as const) {
    const list = registries?.[listKey]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue
      const env = (entry as { env?: unknown }).env
      if (env !== null && typeof env === 'object') {
        redactMatchingKeys(env as Record<string, unknown>, new Set())
      }
    }
  }

  // Free-form backend config — only redact top-level keys per backend entry; we
  // don't recurse arbitrarily deep because backend factories own that shape.
  const backends = clone.backends as Record<string, unknown> | undefined
  if (backends !== undefined && backends !== null) {
    for (const [key, value] of Object.entries(backends)) {
      // `default` / `inference` / `agent` are string pointers, not backend entries.
      if (typeof value !== 'object' || value === null) continue
      redactMatchingKeys(value as Record<string, unknown>, new Set())
      // best-effort: also walk a nested `env` map if the backend defines one.
      const env = (value as { env?: unknown }).env
      if (env !== null && typeof env === 'object') {
        redactMatchingKeys(env as Record<string, unknown>, new Set())
      }
      // Keep TS happy without a no-op
      void key
    }
  }

  return clone
}
