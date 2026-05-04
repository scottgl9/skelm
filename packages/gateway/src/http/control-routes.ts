import type { RunEvent } from '@skelm/core'
import {
  type App,
  type H3Event,
  createError,
  createRouter,
  eventHandler,
  getQuery,
  readBody,
} from 'h3'
import type { Gateway } from '../lifecycle/gateway.js'

/**
 * Mount the gateway control surface on an h3 app via a method-aware router:
 * lifecycle (pause/resume/reload), approvals (list/approve/deny), sessions
 * (list/get/resume/delete), triggers (list/fire), and a /health probe.
 *
 * The auth middleware on the parent server applies to every route mounted
 * here. We use a Router (instead of bare app.use) because the existing
 * server registers prefix-matched handlers for /runs and /pipelines that
 * would otherwise shadow our /runs/:runId/approve route.
 */
export function mountControlRoutes(app: App, gateway: Gateway): void {
  const router = createRouter({ preemptive: true })

  router.get(
    '/health',
    eventHandler(async () => ({
      status: 'ok',
      pid: process.pid,
      state: gateway.getState(),
      stateDir: gateway.stateDir,
    })),
  )

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

  router.get(
    '/approvals',
    eventHandler(async () => {
      const gate = gateway.enforcement.approvalGate as {
        list?: () => Array<{ id: string; request: unknown; createdAt: string }>
      }
      if (typeof gate.list !== 'function') return []
      return gate.list()
    }),
  )

  router.post(
    '/runs/:runId/approve',
    eventHandler(async (event: H3Event) => deliverApproval(event, gateway, true)),
  )
  router.post(
    '/runs/:runId/deny',
    eventHandler(async (event: H3Event) => deliverApproval(event, gateway, false)),
  )

  router.get(
    '/sessions',
    eventHandler(async () => gateway.managers.acpSessions.list()),
  )
  router.post(
    '/sessions/:id/resume',
    eventHandler(async (event: H3Event) => {
      const id = event.context.params?.id
      if (!id) throw createError({ statusCode: 400, message: 'session id required' })
      const s = await gateway.managers.acpSessions.resume(id)
      if (s === undefined) {
        throw createError({ statusCode: 404, message: 'session not found or expired' })
      }
      return s
    }),
  )
  router.delete(
    '/sessions/:id',
    eventHandler(async (event: H3Event) => {
      const id = event.context.params?.id
      if (!id) throw createError({ statusCode: 400, message: 'session id required' })
      const ok = await gateway.managers.acpSessions.terminate(id)
      if (!ok) throw createError({ statusCode: 404, message: 'session not found' })
      return { ok: true }
    }),
  )

  router.get(
    '/runs/:runId/events',
    eventHandler(async (event: H3Event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
      const state = await gateway.runStore.getRun(runId)
      if (state === null) throw createError({ statusCode: 404, message: 'Run not found' })

      const query = getQuery(event)
      const opts: { since?: number; limit?: number } = {}
      const sinceRaw = query.since
      const limitRaw = query.limit
      if (typeof sinceRaw === 'string') {
        const since = Number.parseInt(sinceRaw, 10)
        if (!Number.isNaN(since)) opts.since = since
      }
      if (typeof limitRaw === 'string') {
        const limit = Number.parseInt(limitRaw, 10)
        if (!Number.isNaN(limit)) opts.limit = limit
      }

      const events: RunEvent[] = []
      for await (const e of gateway.runStore.listEvents(runId, opts)) {
        events.push(e)
      }
      return { runId, events }
    }),
  )

  router.get(
    '/triggers',
    eventHandler(async () => gateway.managers.triggers.list()),
  )
  router.post(
    '/triggers/:id/fire',
    eventHandler(async (event: H3Event) => {
      const id = event.context.params?.id
      if (!id) throw createError({ statusCode: 400, message: 'trigger id required' })
      await gateway.managers.triggers.fire(id)
      return { ok: true }
    }),
  )

  app.use(router)
}

async function deliverApproval(
  event: H3Event,
  gateway: Gateway,
  approve: boolean,
): Promise<{ delivered: boolean }> {
  const runId = event.context.params?.runId
  if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
  const body = (await readBody(event).catch(() => ({}))) as {
    stepId?: string
    approver?: string
    reason?: string
  }
  if (!body.stepId) throw createError({ statusCode: 400, message: 'stepId required' })
  const id = `${runId}:${body.stepId}`
  const gate = gateway.enforcement.approvalGate as {
    approve?: (id: string, approver?: string, reason?: string) => boolean
    deny?: (id: string, approver?: string, reason?: string) => boolean
  }
  const fn = approve ? gate.approve : gate.deny
  if (typeof fn !== 'function') {
    throw createError({ statusCode: 501, message: 'configured approval gate is not interactive' })
  }
  const delivered = fn.call(gate, id, body.approver, body.reason)
  if (!delivered) throw createError({ statusCode: 404, message: 'no pending approval' })
  return { delivered }
}
