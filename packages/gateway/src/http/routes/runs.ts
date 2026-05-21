import type { RunEvent } from '@skelm/core'
import { type Router, createError, eventHandler, getQuery, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'

export function registerRunRoutes(router: Router, gateway: Gateway): void {
  router.delete(
    '/runs/:runId',
    eventHandler(async (event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
      const cancelled = gateway.cancel(runId, 'cancelled via HTTP DELETE')
      if (!cancelled) {
        throw createError({
          statusCode: 404,
          message: 'run not in flight (already completed, or unknown to this gateway)',
        })
      }
      return { cancelled: true, runId }
    }),
  )

  router.post(
    '/runs/:runId/resume',
    eventHandler(async (event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
      const runner = gateway.getRunner(runId)
      if (runner === undefined) {
        throw createError({
          statusCode: 404,
          message: 'no in-flight runner for runId (already completed, or unknown to this gateway)',
        })
      }
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object' ? (rawBody as { output?: unknown }) : {}
      try {
        await runner.resume(runId, body.output ?? {})
        return { resumed: true, runId }
      } catch (err) {
        throw createError({ statusCode: 400, message: (err as Error).message })
      }
    }),
  )

  router.get(
    '/runs/:runId/events',
    eventHandler(async (event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
      const state = await gateway.runStore.getRun(runId)
      if (state === null) throw createError({ statusCode: 404, message: 'Run not found' })

      const query = getQuery(event)
      // Clamp limit: default 1000 events, hard cap 5000 per request so a
      // single GET cannot materialise the entire event log of a
      // long-running pipeline. Use `since` for incremental tailing.
      const opts: { since?: number; limit?: number } = { limit: 1000 }
      const sinceRaw = query.since
      const limitRaw = query.limit
      if (typeof sinceRaw === 'string') {
        const since = Number.parseInt(sinceRaw, 10)
        if (!Number.isNaN(since)) opts.since = since
      }
      if (typeof limitRaw === 'string') {
        const limit = Number.parseInt(limitRaw, 10)
        if (!Number.isNaN(limit)) opts.limit = Math.max(1, Math.min(5000, limit))
      }

      const events: RunEvent[] = []
      for await (const e of gateway.runStore.listEvents(runId, opts)) {
        events.push(e)
      }
      return { runId, events }
    }),
  )
}
