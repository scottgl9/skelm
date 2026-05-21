import { type Router, createError, eventHandler } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'

/**
 * Liveness vs readiness:
 *   GET /healthz — process alive. Always 200 while the gateway process
 *                  is up. Use for systemd/k8s liveness probes.
 *   GET /readyz  — fully booted + dependencies reachable. 200 only when
 *                  state === 'running'. Use for load-balancer / k8s
 *                  readiness probes to gate traffic during startup or
 *                  draining shutdown.
 *   GET /health  — legacy alias for /healthz; preserved for callers
 *                  that already poll it.
 */
export function registerHealthRoutes(router: Router, gateway: Gateway): void {
  const liveness = () => ({
    status: 'ok',
    pid: process.pid,
    state: gateway.getState(),
    stateDir: gateway.stateDir,
  })
  router.get(
    '/health',
    eventHandler(async () => liveness()),
  )
  router.get(
    '/healthz',
    eventHandler(async () => liveness()),
  )
  router.get(
    '/readyz',
    eventHandler(async () => {
      const state = gateway.getState()
      if (state !== 'running') {
        throw createError({
          statusCode: 503,
          statusMessage: 'Service Unavailable',
          data: { state, pid: process.pid },
        })
      }
      return {
        status: 'ready',
        pid: process.pid,
        state,
        stateDir: gateway.stateDir,
      }
    }),
  )
}
