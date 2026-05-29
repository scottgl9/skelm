import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'
import {
  ProjectActivationError,
  ProjectActivationService,
} from '../../projects/activation-service.js'

interface ActivateBody {
  dir?: unknown
}

/**
 * Mount POST /v1/projects/activate. The auth middleware on the parent server
 * applies. One service instance per gateway keeps the activated-dir set (used
 * for refresh detection) alive for the gateway's lifetime.
 */
export function registerProjectRoutes(router: Router, gateway: Gateway): void {
  const service = new ProjectActivationService(gateway)

  router.post(
    '/v1/projects/activate',
    eventHandler(async (event) => {
      const body = (await readBody(event).catch(() => ({}))) as ActivateBody
      if (typeof body.dir !== 'string' || body.dir.length === 0) {
        throw createError({ statusCode: 400, message: 'dir is required' })
      }
      try {
        return await service.activate(body.dir)
      } catch (err) {
        if (err instanceof ProjectActivationError) {
          throw createError({ statusCode: err.statusCode, message: err.message })
        }
        throw err
      }
    }),
  )
}
