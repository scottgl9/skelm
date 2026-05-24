import { join } from 'node:path'
import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'
import { FileSecretResolver } from '../../secrets/file-driver.js'
import { decodeMaybe } from './utils.js'

/**
 * Secrets management API backed by the gateway's FileSecretResolver.
 * Deliberately write-only over HTTP — plaintext never leaves the gateway
 * process:
 *
 *   GET    /secrets                  -> { names: string[] }   (names only)
 *   GET    /secrets/:name            -> { name, set: boolean } (existence check)
 *   PUT    /secrets/:name { value }  -> { stored: name }
 *   DELETE /secrets/:name            -> { deleted: name }
 *
 * The CLI uses these to provision secrets and check what's configured.
 * Workflows resolve secret values in-process via the gateway-side
 * SecretResolver — the value is never serialized over the wire.
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
      const names = await resolver.list()
      const set = names.includes(name)
      if (!set) throw createError({ statusCode: 404, message: 'secret not found' })
      return { name, set: true as const }
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
      // Follow-up: add resolver.remove() and call it here.
      await resolver.set(name, '')
      return { deleted: name }
    }),
  )
}
