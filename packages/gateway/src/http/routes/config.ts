import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'

/** Server-config keys that PATCH /v1/config is permitted to update. */
const SERVER_PATCH_KEYS = new Set<string>(['maxConcurrentRuns'])

/** Top-level config keys the PATCH route understands; nested updates use dot-notation. */
const ALLOWED_PATCH_PATHS = new Set<string>(['server.maxConcurrentRuns'])

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
      const next = structuredClone(current) as typeof current
      next.server = next.server ?? {}
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
 * Drop server.auth.token-like fields and any obviously-sensitive nested
 * structures from the config before returning it over HTTP.
 */
function sanitize(config: import('@skelm/core').SkelmConfig): Record<string, unknown> {
  const clone = structuredClone(config) as Record<string, unknown>
  const server = (clone.server ?? {}) as Record<string, unknown>
  if (server.auth !== undefined && typeof server.auth === 'object' && server.auth !== null) {
    const auth = server.auth as Record<string, unknown>
    // Future-proof: never echo a token even if a config ever stores one inline.
    for (const k of Object.keys(auth)) {
      if (k !== 'mode' && SERVER_PATCH_KEYS.has(k) === false) {
        if (k.toLowerCase().includes('token') || k.toLowerCase().includes('secret')) {
          auth[k] = '[redacted]'
        }
      }
    }
  }
  // Secret driver paths are sensitive in some deployments — redact the file path.
  const secrets = (clone.secrets ?? {}) as Record<string, unknown>
  if (typeof secrets.file === 'string') secrets.file = '[redacted]'
  return clone
}
