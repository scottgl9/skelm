import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'

export function registerSessionRoutes(router: Router, gateway: Gateway): void {
  router.get(
    '/sessions',
    eventHandler(async () => gateway.managers.acpSessions.list()),
  )

  router.post(
    '/sessions/:id/resume',
    eventHandler(async (event) => {
      const id = event.context.params?.id
      if (!id) throw createError({ statusCode: 400, message: 'session id required' })
      const s = await gateway.managers.acpSessions.resume(id)
      if (s === undefined) {
        throw createError({ statusCode: 404, message: 'session not found or expired' })
      }
      return s
    }),
  )

  router.post(
    '/sessions/prune',
    eventHandler(async (event) => {
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object'
          ? (rawBody as { expired?: unknown; olderThanMs?: unknown })
          : {}
      const opts: { expired?: boolean; olderThanMs?: number } = {}
      if (body.expired === true) opts.expired = true
      if (typeof body.olderThanMs === 'number') opts.olderThanMs = body.olderThanMs
      const removed = await gateway.managers.acpSessions.prune(opts)
      return { removed }
    }),
  )

  router.delete(
    '/sessions/:id',
    eventHandler(async (event) => {
      const id = event.context.params?.id
      if (!id) throw createError({ statusCode: 400, message: 'session id required' })
      const ok = await gateway.managers.acpSessions.terminate(id)
      if (!ok) throw createError({ statusCode: 404, message: 'session not found' })
      return { ok: true }
    }),
  )
}
