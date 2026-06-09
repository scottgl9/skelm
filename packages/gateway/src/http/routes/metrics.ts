import { type Router, createError, eventHandler } from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'

export function registerMetricsRoutes(router: Router, gateway: GatewayContext): void {
  router.get(
    '/metrics',
    eventHandler(async (event) => {
      const collector = gateway.metrics
      if (collector === null) {
        throw createError({
          statusCode: 404,
          message: 'metrics are not enabled (start the gateway with enableMetrics: true)',
        })
      }
      const gate = gateway.enforcement.approvalGate as { list?: () => unknown[] }
      if (typeof gate.list === 'function') {
        collector.setApprovalsPending(gate.list().length)
      }
      event.node.res.setHeader('content-type', 'text/plain; version=0.0.4')
      return collector.render()
    }),
  )
}
