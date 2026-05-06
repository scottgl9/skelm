import { type Router, eventHandler } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'

export function registerHealthRoutes(router: Router, gateway: Gateway): void {
  router.get(
    '/health',
    eventHandler(async () => ({
      status: 'ok',
      pid: process.pid,
      state: gateway.getState(),
      stateDir: gateway.stateDir,
    })),
  )
}
