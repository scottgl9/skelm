import type { RunStatus } from '@skelm/core'
import { type Router, createError, eventHandler, getQuery } from 'h3'
import { DashboardService } from '../../dashboard/dashboard-service.js'
import type { AnalyticsMetric, AnalyticsResolution } from '../../dashboard/types.js'
import type { Gateway } from '../../lifecycle/gateway.js'

const GATEWAY_VERSION = '0.4.0'

const VALID_METRICS: ReadonlySet<AnalyticsMetric> = new Set([
  'runs-per-hour',
  'success-rate',
  'avg-duration',
])

const VALID_RESOLUTIONS: ReadonlySet<AnalyticsResolution> = new Set(['hour', 'day', 'week'])

const VALID_STATUSES: ReadonlySet<RunStatus> = new Set([
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
])

/**
 * Mounts read-only /v1/dashboard/* endpoints. The service is constructed lazily
 * on first request so a Gateway that starts without the dashboard ever being
 * called incurs no extra cost.
 */
export function registerDashboardRoutes(router: Router, gateway: Gateway): void {
  let service: DashboardService | null = null
  const getService = (): DashboardService => {
    if (service === null) {
      service = new DashboardService({
        runStore: gateway.runStore,
        listWorkflows: () => gateway.registries.workflows.list(),
        listSchedules: () => gateway.managers.triggers.list(),
        approvals: {
          list: () => {
            const gate = gateway.enforcement.approvalGate as {
              list?: () => Array<{ id: string; createdAt: string; request: unknown }>
            }
            return typeof gate.list === 'function' ? gate.list() : []
          },
        },
        version: GATEWAY_VERSION,
        startedAt: parseStartedAt(gateway.getDiscovery()?.startedAt),
      })
    }
    return service
  }

  router.get(
    '/v1/dashboard/overview',
    eventHandler(async () => getService().overview()),
  )

  router.get(
    '/v1/dashboard/workflows',
    eventHandler(async () => ({ workflows: await getService().workflowStats() })),
  )

  router.get(
    '/v1/dashboard/runs',
    eventHandler(async (event) => {
      const q = getQuery(event)
      const status = parseStatus(q.status)
      const dateFrom = parseIntOrUndef(q.dateFrom)
      const dateTo = parseIntOrUndef(q.dateTo)
      const limit = parseIntOrUndef(q.limit)
      const out = await getService().listRuns({
        ...(typeof q.workflowId === 'string' && { workflowId: q.workflowId }),
        ...(status !== undefined && { status }),
        ...(dateFrom !== undefined && { dateFrom }),
        ...(dateTo !== undefined && { dateTo }),
        ...(limit !== undefined && { limit }),
      })
      return { runs: out }
    }),
  )

  router.get(
    '/v1/dashboard/analytics',
    eventHandler(async (event) => {
      const q = getQuery(event)
      const metric = typeof q.metric === 'string' ? (q.metric as AnalyticsMetric) : undefined
      const resolution =
        typeof q.resolution === 'string' ? (q.resolution as AnalyticsResolution) : 'hour'
      if (metric === undefined || !VALID_METRICS.has(metric)) {
        throw createError({
          statusCode: 400,
          message: `metric required; one of ${[...VALID_METRICS].join(', ')}`,
        })
      }
      if (!VALID_RESOLUTIONS.has(resolution)) {
        throw createError({
          statusCode: 400,
          message: `resolution must be one of ${[...VALID_RESOLUTIONS].join(', ')}`,
        })
      }
      const dateTo = parseIntOrUndef(q.dateTo) ?? Date.now()
      const defaultWindow = resolution === 'week' ? 30 * 86_400_000 : 86_400_000
      const dateFrom = parseIntOrUndef(q.dateFrom) ?? dateTo - defaultWindow
      if (dateFrom >= dateTo) {
        throw createError({ statusCode: 400, message: 'dateFrom must be < dateTo' })
      }
      return getService().analytics({
        metric,
        resolution,
        dateFrom,
        dateTo,
        ...(typeof q.workflowId === 'string' && { workflowId: q.workflowId }),
      })
    }),
  )

  router.get(
    '/v1/dashboard/errors',
    eventHandler(async (event) => {
      const q = getQuery(event)
      const limit = parseIntOrUndef(q.limit)
      return getService().errors({ ...(limit !== undefined && { limit }) })
    }),
  )

  router.get(
    '/v1/dashboard/schedules',
    eventHandler(async () => ({ schedules: getService().schedules() })),
  )

  router.get(
    '/v1/dashboard/approvals',
    eventHandler(async () => getService().approvals()),
  )
}

function parseStartedAt(raw: string | undefined): number {
  if (raw === undefined) return Date.now()
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function parseIntOrUndef(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isNaN(n) ? undefined : n
}

function parseStatus(raw: unknown): RunStatus | undefined {
  if (typeof raw !== 'string') return undefined
  return VALID_STATUSES.has(raw as RunStatus) ? (raw as RunStatus) : undefined
}
