import { type Router, createError, eventHandler, getQuery } from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'

const MAX_LIMIT = 1000

export function registerStateRoutes(router: Router, gateway: GatewayContext): void {
  router.get(
    '/v1/state/:namespace',
    eventHandler(async (event) => {
      const namespace = readParam(event.context.params?.namespace, 'namespace')
      const q = getQuery(event)
      const prefix = typeof q.prefix === 'string' ? q.prefix : undefined
      const limit = parseLimit(q.limit)
      const entries: Array<{ key: string; value: unknown }> = []
      let truncated = false
      for await (const entry of gateway.runStore.listState(namespace, prefix)) {
        if (entries.length >= limit) {
          truncated = true
          break
        }
        entries.push({ key: entry.key, value: entry.value })
      }
      return { namespace, entries, truncated }
    }),
  )

  router.get(
    '/v1/state/:namespace/:key',
    eventHandler(async (event) => {
      const namespace = readParam(event.context.params?.namespace, 'namespace')
      const key = readParam(event.context.params?.key, 'key')
      const value = await gateway.runStore.getState(namespace, key)
      if (value === undefined)
        throw createError({ statusCode: 404, message: 'state key not found' })
      return { namespace, key, value }
    }),
  )
}

function readParam(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw createError({ statusCode: 400, message: `${name} required` })
  }
  return decodeURIComponent(value)
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return 100
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw createError({ statusCode: 400, message: 'limit must be a non-negative integer' })
  }
  return Math.max(1, Math.min(MAX_LIMIT, Number.parseInt(raw, 10)))
}
