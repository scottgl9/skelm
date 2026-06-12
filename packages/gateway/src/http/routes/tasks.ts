import type { DeliveryTarget, RunEvent, TaskFilter, TaskStatus } from '@skelm/core'
import { type Router, createError, eventHandler, getQuery, readBody } from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'
import { buildLineage } from '../../tasks/lineage.js'
import { TaskError } from '../../tasks/task-service.js'

const VALID_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
])

export function registerTaskRoutes(router: Router, gateway: GatewayContext): void {
  router.get(
    '/v1/tasks',
    eventHandler(async (event) => {
      const q = getQuery(event)
      const filter: TaskFilter = {
        ...(typeof q.status === 'string' && { status: parseStatus(q.status) }),
        ...(typeof q.parentRunId === 'string' && { parentRunId: q.parentRunId }),
        ...(typeof q.workflowId === 'string' && { workflowId: q.workflowId }),
        ...(typeof q.limit === 'string' && { limit: parseLimit(q.limit) }),
      }
      const tasks = await gateway.tasks.listTasks(filter)
      return { tasks }
    }),
  )

  router.get(
    '/v1/tasks/:id',
    eventHandler(async (event) => {
      const id = readParam(event.context.params?.id)
      return runMapped(() => gateway.tasks.getTask(id))
    }),
  )

  router.post(
    '/v1/tasks',
    eventHandler(async (event) => {
      const raw = await readBody(event).catch(() => undefined)
      const body =
        raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
      if (
        body === undefined ||
        typeof body.workflowId !== 'string' ||
        body.workflowId.length === 0
      ) {
        throw createError({ statusCode: 400, message: 'workflowId is required' })
      }
      const deliveryTarget = parseDeliveryTarget(body.deliveryTarget)
      return runMapped(() =>
        gateway.tasks.createTask({
          workflowId: body.workflowId as string,
          ...(body.input !== undefined && { input: body.input }),
          ...(typeof body.parentRunId === 'string' && { parentRunId: body.parentRunId }),
          ...(typeof body.parentStepId === 'string' && { parentStepId: body.parentStepId }),
          ...(typeof body.parentSessionId === 'string' && {
            parentSessionId: body.parentSessionId,
          }),
          ...(deliveryTarget !== undefined && { deliveryTarget }),
        }),
      )
    }),
  )

  router.post(
    '/v1/tasks/:id/cancel',
    eventHandler(async (event) => {
      const id = readParam(event.context.params?.id)
      return runMapped(() => gateway.tasks.cancelTask(id))
    }),
  )

  router.post(
    '/v1/tasks/:id/retry',
    eventHandler(async (event) => {
      const id = readParam(event.context.params?.id)
      return runMapped(() => gateway.tasks.retryTask(id))
    }),
  )

  // Replay the child run's persisted event log. Same shape and clamp as
  // GET /runs/:runId/events — the documented run-events replay endpoint.
  router.get(
    '/v1/tasks/:id/events',
    eventHandler(async (event) => {
      const id = readParam(event.context.params?.id)
      const task = await runMapped(() => gateway.tasks.getTask(id))
      if (task.childRunId === undefined) {
        return { taskId: id, runId: null, events: [] as RunEvent[] }
      }
      const q = getQuery(event)
      const opts: { since?: number; limit?: number } = { limit: 1000 }
      if (typeof q.since === 'string') {
        const since = Number.parseInt(q.since, 10)
        if (!Number.isNaN(since)) opts.since = since
      }
      if (typeof q.limit === 'string') {
        const limit = Number.parseInt(q.limit, 10)
        if (!Number.isNaN(limit)) opts.limit = Math.max(1, Math.min(5000, limit))
      }
      const events: RunEvent[] = []
      for await (const e of gateway.runStore.listEvents(task.childRunId, opts)) {
        events.push(e)
      }
      return { taskId: id, runId: task.childRunId, events }
    }),
  )

  router.get(
    '/v1/lineage/:runId',
    eventHandler(async (event) => {
      const runId = readParam(event.context.params?.runId)
      const lineage = await buildLineage(gateway.runStore, runId)
      if (lineage === null) throw createError({ statusCode: 404, message: 'run not found' })
      return lineage
    }),
  )
}

async function runMapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof TaskError) {
      throw createError({ statusCode: err.statusCode, message: err.message })
    }
    throw err
  }
}

function readParam(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw createError({ statusCode: 400, message: 'id required' })
  }
  return decodeURIComponent(value)
}

function parseStatus(raw: string): TaskStatus {
  if (!VALID_STATUSES.has(raw as TaskStatus)) {
    throw createError({ statusCode: 400, message: `invalid status: ${raw}` })
  }
  return raw as TaskStatus
}

function parseLimit(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw createError({ statusCode: 400, message: 'limit must be a non-negative integer' })
  }
  return Math.max(1, Math.min(1000, Number.parseInt(raw, 10)))
}

function parseDeliveryTarget(raw: unknown): DeliveryTarget | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null) {
    throw createError({ statusCode: 400, message: 'deliveryTarget must be an object' })
  }
  const dt = raw as Record<string, unknown>
  if (typeof dt.kind !== 'string' || typeof dt.target !== 'string') {
    throw createError({
      statusCode: 400,
      message: 'deliveryTarget requires string kind and target',
    })
  }
  return {
    kind: dt.kind,
    target: dt.target,
    ...(dt.metadata !== undefined &&
      typeof dt.metadata === 'object' &&
      dt.metadata !== null && { metadata: dt.metadata as Record<string, unknown> }),
  }
}
