import { type Router, createError, eventHandler, readBody } from 'h3'
import { TokenValidationError } from '../../auth/token-store.js'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'

/**
 * Admin token-management API. All three routes require the `admin:administer`
 * scope (enforced by the server auth middleware via the route-scope map; the
 * legacy ROOT token satisfies it). RBAC is opt-in: issuing the first token
 * here flips the gateway from legacy single-token mode into scoped mode.
 *
 * POST   /v1/admin/tokens            create — returns the plaintext secret ONCE
 * GET    /v1/admin/tokens            list   — metadata only (never hash/secret)
 * POST   /v1/admin/tokens/:id/revoke revoke — marks a token revoked
 *
 * Every mutating action is audited through the gateway's single audit writer.
 * The plaintext secret is never logged or audited.
 */
export function registerAdminTokenRoutes(router: Router, gateway: GatewayContext): void {
  router.post(
    '/v1/admin/tokens',
    eventHandler(async (event) => {
      const body = (await readBody(event).catch(() => ({}))) as Record<string, unknown>
      if (typeof body !== 'object' || body === null) {
        throw createError({ statusCode: 400, message: 'request body must be an object' })
      }
      const roles = body.roles
      const scopes = body.scopes
      if (roles !== undefined && !isStringArray(roles)) {
        throw createError({ statusCode: 400, message: 'roles: must be an array of strings' })
      }
      if (scopes !== undefined && !isStringArray(scopes)) {
        throw createError({ statusCode: 400, message: 'scopes: must be an array of strings' })
      }
      if (body.label !== undefined && typeof body.label !== 'string') {
        throw createError({ statusCode: 400, message: 'label: must be a string' })
      }
      if (body.expiresAt !== undefined && typeof body.expiresAt !== 'string') {
        throw createError({ statusCode: 400, message: 'expiresAt: must be an ISO-8601 string' })
      }
      try {
        const created = await gateway.tokenStore.create({
          ...(roles !== undefined && { roles: roles as string[] }),
          ...(scopes !== undefined && { scopes: scopes as string[] }),
          ...(body.label !== undefined && { label: body.label as string }),
          ...(body.expiresAt !== undefined && { expiresAt: body.expiresAt as string }),
        })
        await gateway.enforcement.auditWriter.write({
          actor: 'gateway',
          action: 'auth.token.created',
          details: {
            tokenId: created.token.id,
            roles: created.token.roles,
            scopes: created.token.scopes,
            ...(created.token.label !== undefined && { label: created.token.label }),
            ...(created.token.expiresAt !== undefined && { expiresAt: created.token.expiresAt }),
          },
        })
        // `secret` is returned exactly once and never persisted in plaintext.
        return { secret: created.secret, token: created.token }
      } catch (err) {
        if (err instanceof TokenValidationError) {
          throw createError({ statusCode: 400, message: err.message })
        }
        throw err
      }
    }),
  )

  router.get(
    '/v1/admin/tokens',
    eventHandler(async () => ({ tokens: gateway.tokenStore.list() })),
  )

  router.post(
    '/v1/admin/tokens/:id/revoke',
    eventHandler(async (event) => {
      const id = event.context.params?.id
      if (!id) throw createError({ statusCode: 400, message: 'token id required' })
      const ok = await gateway.tokenStore.revoke(id)
      if (!ok) throw createError({ statusCode: 404, message: 'token not found' })
      await gateway.enforcement.auditWriter.write({
        actor: 'gateway',
        action: 'auth.token.revoked',
        details: { tokenId: id },
      })
      return { revoked: true, id }
    }),
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}
