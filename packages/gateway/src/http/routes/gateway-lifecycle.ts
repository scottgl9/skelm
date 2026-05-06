import { type Router, createError, eventHandler } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'

export function registerGatewayLifecycleRoutes(router: Router, gateway: Gateway): void {
  router.post(
    '/gateway/pause',
    eventHandler(async () => {
      try {
        await gateway.pause()
        return { state: gateway.getState() }
      } catch (err) {
        throw createError({ statusCode: 409, message: (err as Error).message })
      }
    }),
  )

  router.post(
    '/gateway/resume',
    eventHandler(async () => {
      try {
        await gateway.resume()
        return { state: gateway.getState() }
      } catch (err) {
        throw createError({ statusCode: 409, message: (err as Error).message })
      }
    }),
  )

  router.post(
    '/gateway/reload',
    eventHandler(async () => {
      await gateway.reload()
      return { state: gateway.getState() }
    }),
  )
}
