import { type Router, eventHandler, getQuery } from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'

export function registerAgentmemoryRoutes(router: Router, gateway: GatewayContext): void {
  router.get(
    '/v1/agentmemory/status',
    eventHandler(async () => {
      const client = gateway.getAgentmemoryClient()
      if (client === null) return { enabled: false }
      try {
        return { enabled: true, health: await client.health() }
      } catch (err) {
        return {
          enabled: true,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )

  router.get(
    '/v1/agentmemory/sessions',
    eventHandler(async (event) => {
      const client = gateway.getAgentmemoryClient()
      if (client === null) return { enabled: false, sessions: [] }
      const limit = parseLimit(getQuery(event).limit)
      try {
        return { enabled: true, ...(await client.sessions({ limit })) }
      } catch (err) {
        return {
          enabled: true,
          sessions: [],
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )
}

function parseLimit(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return 50
  return Math.max(1, Math.min(500, Number.parseInt(raw, 10)))
}
