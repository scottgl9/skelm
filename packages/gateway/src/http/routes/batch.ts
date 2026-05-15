import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'

export const DEFAULT_BATCH_CAP = 50

interface BatchRunItem {
  id?: unknown
  input?: unknown
}

interface BatchRunsBody {
  items?: unknown
}

interface BatchCancelBody {
  runIds?: unknown
}

/**
 * Mount POST /v1/batch/runs and POST /v1/batch/cancel. Both endpoints
 * accept a list and report per-item outcome. The /runs handler fans out
 * to gateway.startPipelineAsync — the same code path /pipelines/:id/start
 * uses — so new options (enforcement hooks, context propagation) reach
 * the batch path automatically. Per-item errors never fail the whole
 * batch; the /cancel handler forwards to gateway.cancel(runId).
 */
export function registerBatchRoutes(router: Router, gateway: Gateway): void {
  router.post(
    '/v1/batch/runs',
    eventHandler(async (event) => {
      const body = (await readBody(event).catch(() => ({}))) as BatchRunsBody
      const items = Array.isArray(body.items) ? (body.items as BatchRunItem[]) : null
      if (items === null) {
        throw createError({ statusCode: 400, message: 'items must be an array' })
      }
      const cap = gateway.getBatchMaxItemsPerRequest()
      if (items.length > cap) {
        throw createError({
          statusCode: 400,
          message: `batch size ${items.length} exceeds cap ${cap}`,
        })
      }
      const results = await Promise.all(items.map(async (item) => startOne(gateway, item)))
      return { items: results }
    }),
  )

  router.post(
    '/v1/batch/cancel',
    eventHandler(async (event) => {
      const body = (await readBody(event).catch(() => ({}))) as BatchCancelBody
      const runIds = Array.isArray(body.runIds) ? (body.runIds as unknown[]) : null
      if (runIds === null) {
        throw createError({ statusCode: 400, message: 'runIds must be an array' })
      }
      const items = runIds.map((raw) => {
        if (typeof raw !== 'string' || raw.length === 0) {
          return { runId: String(raw), cancelled: false, error: 'invalid runId' }
        }
        const cancelled = gateway.cancel(raw, 'cancelled via /v1/batch/cancel')
        return cancelled
          ? { runId: raw, cancelled: true }
          : { runId: raw, cancelled: false, error: 'not in flight' }
      })
      return { items }
    }),
  )
}

async function startOne(
  gateway: Gateway,
  item: BatchRunItem,
): Promise<{
  id: string
  accepted: boolean
  runId?: string
  error?: string
  description?: string
}> {
  const id = typeof item.id === 'string' ? item.id : ''
  if (id.length === 0) {
    return { id, accepted: false, error: 'id required', description: 'invalid-input' }
  }
  try {
    const { runId } = await gateway.startPipelineAsync(id, item.input ?? {})
    return { id, accepted: true, runId, description: 'started' }
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode
    const description = status === 404 ? 'workflow-not-found' : 'start-failed'
    return {
      id,
      accepted: false,
      error: (err as Error).message,
      description,
    }
  }
}
