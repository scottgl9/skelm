import { type H3Event, type Router, createError, eventHandler, readBody } from 'h3'
import {
  type HitlResolution,
  HitlResolutionError,
  auditHitl,
  buildDecision,
  getPendingHitl,
  listPendingHitl,
} from '../../hitl/hitl-service.js'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'

/**
 * Human-in-the-loop gate API. Lists pending gates, fetches one, and resolves a
 * gate with a typed decision. Resolution audits through the single gateway
 * audit writer (`hitl.<decision>`) and drives the run forward via the same
 * durable resume path that backs wait(). Bearer auth is enforced by the server
 * middleware that mounts these routes.
 */
export function registerHitlRoutes(router: Router, gateway: GatewayContext): void {
  router.get(
    '/v1/hitl',
    eventHandler(async () => ({ pending: await listPendingHitl(gateway.runStore) })),
  )

  router.get(
    '/v1/hitl/:runId',
    eventHandler(async (event: H3Event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
      const pending = await getPendingHitl(gateway.runStore, runId)
      if (pending === null)
        throw createError({ statusCode: 404, message: 'no pending HITL gate for run' })
      return pending
    }),
  )

  router.post(
    '/v1/hitl/:runId/resolve',
    eventHandler(async (event: H3Event) => resolve(event, gateway)),
  )
}

async function resolve(
  event: H3Event,
  gateway: GatewayContext,
): Promise<{ resolved: true; runId: string; rehydrated?: true }> {
  const runId = event.context.params?.runId
  if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
  const body = (await readBody(event).catch(() => ({}))) as Partial<HitlResolution>
  if (typeof body.decision !== 'string') {
    throw createError({ statusCode: 400, message: 'decision required' })
  }
  const pending = await getPendingHitl(gateway.runStore, runId)
  if (pending === null) {
    throw createError({ statusCode: 404, message: 'no pending HITL gate for run' })
  }

  let decision: ReturnType<typeof buildDecision>
  try {
    decision = buildDecision(pending.gate, body as HitlResolution)
  } catch (err) {
    if (err instanceof HitlResolutionError) {
      throw createError({ statusCode: err.statusCode, message: err.message })
    }
    throw err
  }

  // Audit BEFORE driving the run forward so a crash between resolution and the
  // run continuing can't leave a decision off the durable record.
  await auditHitl(gateway.enforcement.auditWriter, pending, decision)

  const runner = gateway.getRunner(runId)
  if (runner !== undefined) {
    try {
      await runner.resume(runId, decision)
    } catch (err) {
      throw createError({ statusCode: 400, message: (err as Error).message })
    }
    return { resolved: true, runId }
  }
  try {
    await gateway.resumeWaitingRun(runId, decision)
    return { resolved: true, runId, rehydrated: true }
  } catch (err) {
    const statusCode =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 404
    throw createError({ statusCode, message: (err as Error).message })
  }
}
