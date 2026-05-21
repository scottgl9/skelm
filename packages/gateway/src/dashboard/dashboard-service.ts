import type { RunFilter, RunStatus, RunStore, RunSummary } from '@skelm/core'
import type { WorkflowEntry } from '../registries/workflow-registry.js'
import type { TriggerRegistration } from '../triggers/types.js'
import type {
  AnalyticsMetric,
  AnalyticsPoint,
  AnalyticsResolution,
  DashboardAnalytics,
  DashboardApprovals,
  DashboardErrors,
  DashboardOverview,
  DashboardRunListItem,
  DashboardScheduleStatus,
  DashboardWorkflowStats,
} from './types.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

const RUN_STATUSES: readonly RunStatus[] = [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]

export interface DashboardApprovalEntry {
  id: string
  createdAt: string
  request: unknown
}

export interface DashboardApprovalSource {
  list(): ReadonlyArray<DashboardApprovalEntry>
}

export interface DashboardServiceDeps {
  runStore: RunStore
  listWorkflows: () => ReadonlyArray<WorkflowEntry>
  listSchedules: () => ReadonlyArray<TriggerRegistration>
  approvals: DashboardApprovalSource
  version: string
  startedAt: number
  now?: () => number
  cacheTtlMs?: number
}

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export interface RunListQuery {
  workflowId?: string
  status?: RunStatus
  dateFrom?: number
  dateTo?: number
  limit?: number
}

export class DashboardService {
  private readonly cache = new Map<string, CacheEntry<unknown>>()
  private readonly cacheTtlMs: number
  private readonly now: () => number

  constructor(private readonly deps: DashboardServiceDeps) {
    this.cacheTtlMs = deps.cacheTtlMs ?? 5_000
    this.now = deps.now ?? Date.now
  }

  async overview(): Promise<DashboardOverview> {
    return this.cached('overview', async () => {
      const now = this.now()
      const since24h = now - DAY_MS
      const [workflows, runs24h, runsAll, schedules, approvals] = await Promise.all([
        Promise.resolve(this.deps.listWorkflows()),
        collect(this.deps.runStore.listRuns({ startedAfter: since24h })),
        collect(this.deps.runStore.listRuns({ limit: 1000 })),
        Promise.resolve(this.deps.listSchedules()),
        Promise.resolve(this.deps.approvals.list()),
      ])
      const byStatus = countByStatus(runsAll)
      const avgDurationMs = averageDuration(runsAll)
      const recentFailures = await this.recentFailureEntries(
        runs24h.filter((r) => r.status === 'failed'),
        5,
      )
      const oldestApproval = approvals.reduce<number | null>((min, a) => {
        const created = Date.parse(a.createdAt)
        if (Number.isNaN(created)) return min
        const age = now - created
        return min === null || age > min ? age : min
      }, null)
      const failedPipelines = new Set(
        runs24h.filter((r) => r.status === 'failed').map((r) => r.pipelineId),
      )
      return {
        gateway: {
          status: 'running',
          uptimeMs: Math.max(0, now - this.deps.startedAt),
          version: this.deps.version,
          startedAt: this.deps.startedAt,
        },
        workflows: {
          total: workflows.length,
          withRecentFailures: workflows.filter((w) => failedPipelines.has(workflowIdFromPath(w)))
            .length,
        },
        runs: {
          total: runsAll.length,
          byStatus,
          avgDurationMs,
          last24h: runs24h.length,
        },
        schedules: {
          total: schedules.length,
          inflight: schedules.filter((s) => s.inflight).length,
          withErrors: schedules.filter((s) => s.lastError !== undefined).length,
        },
        approvals: {
          pending: approvals.length,
          oldestPendingAgeMs: oldestApproval,
        },
        errors: {
          last24h: runs24h.filter((r) => r.status === 'failed').length,
          recent: recentFailures,
        },
      }
    })
  }

  async workflowStats(): Promise<ReadonlyArray<DashboardWorkflowStats>> {
    const workflows = this.deps.listWorkflows()
    const allRuns = await collect(this.deps.runStore.listRuns({ limit: 5000 }))
    return workflows.map((entry) => {
      const id = entry.id
      const runs = allRuns.filter(
        (r) => r.pipelineId === id || r.pipelineId === workflowIdFromPath(entry),
      )
      const completed = runs.filter((r) => r.status === 'completed').length
      const last = runs[0]
      return {
        id,
        file: entry.path,
        totalRuns: runs.length,
        lastRunAt: last?.startedAt ?? null,
        lastStatus: last?.status ?? null,
        successRate: runs.length === 0 ? null : completed / runs.length,
      }
    })
  }

  async listRuns(query: RunListQuery): Promise<ReadonlyArray<DashboardRunListItem>> {
    const filter: RunFilter = {
      ...(query.workflowId !== undefined && { pipelineId: query.workflowId }),
      ...(query.status !== undefined && { status: query.status }),
      ...(query.dateFrom !== undefined && { startedAfter: query.dateFrom }),
      ...(query.dateTo !== undefined && { startedBefore: query.dateTo }),
      ...(query.limit !== undefined && { limit: query.limit }),
    }
    const runs = await collect(this.deps.runStore.listRuns(filter))
    return runs.map((r) => ({
      runId: r.runId,
      pipelineId: r.pipelineId,
      status: r.status,
      startedAt: r.startedAt,
      ...(r.completedAt !== undefined && {
        completedAt: r.completedAt,
        durationMs: r.completedAt - r.startedAt,
      }),
    }))
  }

  async analytics(query: {
    metric: AnalyticsMetric
    resolution: AnalyticsResolution
    dateFrom: number
    dateTo: number
    workflowId?: string
  }): Promise<DashboardAnalytics> {
    return this.cached(`analytics:${JSON.stringify(query)}`, async () => {
      const filter: RunFilter = {
        startedAfter: query.dateFrom,
        startedBefore: query.dateTo,
        ...(query.workflowId !== undefined && { pipelineId: query.workflowId }),
      }
      const runs = await collect(this.deps.runStore.listRuns(filter))
      const bucketMs = resolutionMs(query.resolution)
      const points = bucketRuns(runs, query.dateFrom, query.dateTo, bucketMs, query.metric)
      return {
        metric: query.metric,
        resolution: query.resolution,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        ...(query.workflowId !== undefined && { workflowId: query.workflowId }),
        points,
      }
    })
  }

  async errors(opts: { limit?: number } = {}): Promise<DashboardErrors> {
    const limit = opts.limit ?? 25
    const now = this.now()
    const since = now - DAY_MS
    const runs = await collect(
      this.deps.runStore.listRuns({ status: 'failed', startedAfter: since }),
    )
    const recent: Array<{ runId: string; pipelineId: string; message: string; at: number }> = []
    for (const run of runs.slice(0, limit)) {
      const message = await this.lastErrorMessage(run)
      recent.push({
        runId: run.runId,
        pipelineId: run.pipelineId,
        message,
        at: run.completedAt ?? run.startedAt,
      })
    }
    const groupMap = new Map<
      string,
      { count: number; lastAt: number; message: string; pipelineId: string }
    >()
    for (const entry of recent) {
      const key = `${entry.pipelineId}::${entry.message}`
      const prior = groupMap.get(key)
      if (prior === undefined) {
        groupMap.set(key, {
          count: 1,
          lastAt: entry.at,
          message: entry.message,
          pipelineId: entry.pipelineId,
        })
      } else {
        prior.count += 1
        prior.lastAt = Math.max(prior.lastAt, entry.at)
      }
    }
    const topGroups = [...groupMap.values()].sort((a, b) => b.count - a.count).slice(0, 10)
    return { last24h: runs.length, recent, topGroups }
  }

  schedules(): ReadonlyArray<DashboardScheduleStatus> {
    return this.deps.listSchedules().map((reg) => ({
      id: reg.spec.id,
      kind: reg.spec.kind,
      workflowId: reg.spec.workflowId,
      fired: reg.fired,
      inflight: reg.inflight,
      lastFiredAt: reg.lastFiredAt ?? null,
      lastError: reg.lastError ?? null,
    }))
  }

  approvals(): DashboardApprovals {
    const now = this.now()
    const entries = this.deps.approvals.list()
    let oldest: number | null = null
    const pending = entries.map((e) => {
      const created = Date.parse(e.createdAt)
      const ageMs = Number.isNaN(created) ? 0 : now - created
      if (oldest === null || ageMs > oldest) oldest = ageMs
      return { id: e.id, createdAt: e.createdAt, ageMs, request: e.request }
    })
    return {
      pendingCount: pending.length,
      oldestPendingAgeMs: oldest,
      pending,
    }
  }

  /** Clear all cached responses. Tests use this; nothing else should need to. */
  clearCache(): void {
    this.cache.clear()
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.cacheTtlMs <= 0) return fn()
    const now = this.now()
    const hit = this.cache.get(key)
    if (hit !== undefined && hit.expiresAt > now) return hit.value as T
    const value = await fn()
    this.cache.set(key, { value, expiresAt: now + this.cacheTtlMs })
    return value
  }

  private async recentFailureEntries(
    runs: ReadonlyArray<RunSummary>,
    limit: number,
  ): Promise<DashboardErrors['recent']> {
    const out: Array<{ runId: string; pipelineId: string; message: string; at: number }> = []
    for (const run of runs.slice(0, limit)) {
      const message = await this.lastErrorMessage(run)
      out.push({
        runId: run.runId,
        pipelineId: run.pipelineId,
        message,
        at: run.completedAt ?? run.startedAt,
      })
    }
    return out
  }

  private async lastErrorMessage(run: RunSummary): Promise<string> {
    const full = await this.deps.runStore.getRun(run.runId)
    if (full?.error?.message) return full.error.message
    for (const step of full?.steps ?? []) {
      if (step.error?.message) return step.error.message
    }
    return 'unknown error'
  }
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

function countByStatus(runs: ReadonlyArray<RunSummary>): Record<RunStatus, number> {
  const out = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>
  for (const r of runs) out[r.status] = (out[r.status] ?? 0) + 1
  return out
}

function averageDuration(runs: ReadonlyArray<RunSummary>): number | null {
  const completed = runs.filter((r) => r.completedAt !== undefined)
  if (completed.length === 0) return null
  const total = completed.reduce((sum, r) => sum + ((r.completedAt as number) - r.startedAt), 0)
  return Math.round(total / completed.length)
}

function resolutionMs(res: AnalyticsResolution): number {
  switch (res) {
    case 'hour':
      return HOUR_MS
    case 'day':
      return DAY_MS
    case 'week':
      return WEEK_MS
  }
}

function bucketRuns(
  runs: ReadonlyArray<RunSummary>,
  dateFrom: number,
  dateTo: number,
  bucketMs: number,
  metric: AnalyticsMetric,
): ReadonlyArray<AnalyticsPoint> {
  const start = Math.floor(dateFrom / bucketMs) * bucketMs
  const end = Math.ceil(dateTo / bucketMs) * bucketMs
  const buckets: Array<{ at: number; runs: RunSummary[] }> = []
  for (let t = start; t < end; t += bucketMs) buckets.push({ at: t, runs: [] })
  for (const r of runs) {
    const idx = Math.floor((r.startedAt - start) / bucketMs)
    const bucket = idx >= 0 && idx < buckets.length ? buckets[idx] : undefined
    if (bucket !== undefined) bucket.runs.push(r)
  }
  return buckets.map((b) => ({
    bucketStart: b.at,
    value: computeMetric(b.runs, metric),
  }))
}

function computeMetric(runs: ReadonlyArray<RunSummary>, metric: AnalyticsMetric): number {
  switch (metric) {
    case 'runs-per-hour':
      return runs.length
    case 'success-rate': {
      if (runs.length === 0) return 0
      const ok = runs.filter((r) => r.status === 'completed').length
      return ok / runs.length
    }
    case 'avg-duration': {
      const done = runs.filter((r) => r.completedAt !== undefined)
      if (done.length === 0) return 0
      const total = done.reduce((s, r) => s + ((r.completedAt as number) - r.startedAt), 0)
      return Math.round(total / done.length)
    }
  }
}

function workflowIdFromPath(entry: WorkflowEntry): string {
  return entry.id
}
