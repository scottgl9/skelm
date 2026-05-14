import { Runner } from '@skelm/core'
import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'
import { createSkillSource } from '../../registries/skill-source.js'
import { loadPipelineFromPath, makeGatewayPipelineRegistry } from './utils.js'

const DEFAULT_BATCH_CAP = 50

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
 * to the same async-start path /pipelines/:id/start uses; the /cancel
 * handler forwards to gateway.cancel(runId). Per-item errors never fail
 * the whole batch.
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
      if (items.length > DEFAULT_BATCH_CAP) {
        throw createError({
          statusCode: 400,
          message: `batch size ${items.length} exceeds cap ${DEFAULT_BATCH_CAP}`,
        })
      }
      const loader = gateway.getWorkflowLoader()
      if (loader === undefined) {
        throw createError({ statusCode: 501, message: 'gateway has no workflow loader' })
      }
      const results = await Promise.all(
        items.map(async (item) => startOne(gateway, loader, item)),
      )
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
  loader: (registryId: string, absolutePath: string) => Promise<unknown>,
  item: BatchRunItem,
): Promise<{
  id: string
  accepted: boolean
  runId?: string
  error?: string
}> {
  const id = typeof item.id === 'string' ? item.id : ''
  if (id.length === 0) {
    return { id, accepted: false, error: 'id required' }
  }
  const entry = gateway.registries.workflows.get(id)
  if (entry === undefined) {
    return { id, accepted: false, error: 'pipeline not found' }
  }
  try {
    const pipeline = await loadPipelineFromPath(loader, id, entry.path)
    const enforcement = gateway.enforcement
    const runner = new Runner({
      approvalGate: enforcement.approvalGate,
      secretResolver: enforcement.secretResolver,
      auditWriter: enforcement.auditWriter,
      store: gateway.runStore,
    })
    gateway.attachMetricsBus(runner.events)
    const controller = new AbortController()
    const runId = crypto.randomUUID()
    gateway.registerRun(runId, controller, runner)
    const handle = runner.start(
      pipeline as Parameters<Runner['start']>[0],
      (item.input ?? {}) as never,
      {
        runId,
        signal: controller.signal,
        skillSource: createSkillSource({
          registry: gateway.registries.skills,
          workflowPath: entry.path,
        }),
        pipelineRegistry: makeGatewayPipelineRegistry(gateway),
      },
    )
    void handle
      .wait()
      .catch(() => {})
      .finally(() => gateway.unregisterRun(runId))
    return { id, accepted: true, runId }
  } catch (err) {
    return { id, accepted: false, error: (err as Error).message }
  }
}
