import { type Router, createError, eventHandler, readBody } from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'
import { decodeMaybe } from './utils.js'

export function registerDebugRoutes(router: Router, gateway: GatewayContext): void {
  router.get(
    '/debug/breakpoints',
    eventHandler(async () => ({ breakpoints: gateway.breakpoints.list() })),
  )

  router.post(
    '/debug/breakpoints',
    eventHandler(async (event) => {
      const body = (await readBody(event).catch(() => ({}))) as { stepId?: unknown }
      if (typeof body.stepId !== 'string' || body.stepId === '') {
        throw createError({ statusCode: 400, message: 'stepId required' })
      }
      gateway.breakpoints.add(body.stepId)
      return { added: body.stepId }
    }),
  )

  router.delete(
    '/debug/breakpoints/:stepId',
    eventHandler(async (event) => {
      const stepId = decodeMaybe(event.context.params?.stepId)
      if (!stepId) throw createError({ statusCode: 400, message: 'stepId required' })
      const removed = gateway.breakpoints.remove(stepId)
      if (!removed) throw createError({ statusCode: 404, message: 'breakpoint not set' })
      return { removed: stepId }
    }),
  )

  router.get(
    '/debug/runs',
    eventHandler(async () => ({ paused: gateway.breakpoints.listPaused() })),
  )

  router.post(
    '/debug/runs/:runId/release',
    eventHandler(async (event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
      const released = gateway.breakpoints.release(runId)
      if (!released) {
        throw createError({ statusCode: 404, message: 'run is not paused at a breakpoint' })
      }
      return { released: runId }
    }),
  )
}
