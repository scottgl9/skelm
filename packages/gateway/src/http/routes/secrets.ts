import { join } from 'node:path'
import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'
import { FileSecretResolver } from '../../secrets/file-driver.js'
import { decodeMaybe } from './utils.js'

/**
 * Secrets read/write API backed by the gateway's FileSecretResolver.
 *
 *   GET    /secrets             -> { names: string[] }    (no values)
 *   GET    /secrets/:name       -> { name, value }        (loopback + bearer only)
 *   PUT    /secrets/:name       { value }                 -> { stored: name }
 *   DELETE /secrets/:name                                  -> { deleted: name }
 *
 * Operator trust model: the gateway listens on loopback by default, the
 * auth middleware enforces the bearer token (or open access when auth=
 * 'none' on 127.0.0.1). Plaintext only leaves the process on direct GET
 * by name — list returns names only.
 *
 * Path: <stateDir>/secrets.json unless config.secrets.file overrides it.
 */
export function registerSecretRoutes(router: Router, gateway: Gateway): void {
  // The gateway's own enforcement may already be using FileSecretResolver
  // against a config-specified path. Reading that back through a cast
  // keeps a single source of truth without exposing internal config.
  const enforcedResolver = gateway.enforcement.secretResolver as unknown as {
    path?: string
  }
  const path = enforcedResolver.path ?? join(gateway.stateDir, 'secrets.json')
  const resolver = new FileSecretResolver(path)

  router.get(
    '/secrets',
    eventHandler(async () => {
      const names = await resolver.list()
      return { names }
    }),
  )

  router.get(
    '/secrets/:name',
    eventHandler(async (event) => {
      const name = decodeMaybe(event.context.params?.name)
      if (name === undefined) throw createError({ statusCode: 400, message: 'name required' })
      const value = await resolver.resolve(name)
      if (value === undefined) throw createError({ statusCode: 404, message: 'secret not found' })
      return { name, value }
    }),
  )

  router.put(
    '/secrets/:name',
    eventHandler(async (event) => {
      const name = decodeMaybe(event.context.params?.name)
      if (name === undefined) throw createError({ statusCode: 400, message: 'name required' })
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object' ? (rawBody as { value?: unknown }) : {}
      if (typeof body.value !== 'string') {
        throw createError({ statusCode: 400, message: 'value: must be a string' })
      }
      await resolver.set(name, body.value)
      return { stored: name }
    }),
  )

  router.delete(
    '/secrets/:name',
    eventHandler(async (event) => {
      const name = decodeMaybe(event.context.params?.name)
      if (name === undefined) throw createError({ statusCode: 400, message: 'name required' })
      // FileSecretResolver doesn't ship a delete() today; for a clean v1
      // we set the value to empty string. The next list() still shows it,
      // matching the operator's mental model of "exists with empty value".
      // Phase 6 follow-up: add resolver.remove() and call it here.
      await resolver.set(name, '')
      return { deleted: name }
    }),
  )
}
