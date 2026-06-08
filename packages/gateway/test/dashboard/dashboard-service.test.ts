import { MemoryRunStore } from '@skelm/core'
import type { Run, RunStatus } from '@skelm/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { DashboardService } from '../../src/dashboard/dashboard-service.js'
import type { WorkflowEntry } from '../../src/registries/workflow-registry.js'
import type { TriggerRegistration } from '../../src/triggers/types.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function makeRun(overrides: Partial<Run> & Pick<Run, 'runId'>): Run {
  return {
    pipelineId: 'wf-a',
    status: 'completed',
    input: undefined,
    steps: [],
    output: undefined,
    error: undefined,
    startedAt: 1_000_000,
    completedAt: 1_000_500,
    ...overrides,
  } as Run
}

interface Fixture {
  store: MemoryRunStore
  workflows: WorkflowEntry[]
  schedules: TriggerRegistration[]
  approvals: Array<{ id: string; createdAt: string; request: unknown }>
  now: number
  service: DashboardService
}

function fixture(opts: { now?: number; cacheTtlMs?: number } = {}): Fixture {
  const now = opts.now ?? 10_000_000
  const store = new MemoryRunStore()
  const workflows: WorkflowEntry[] = []
  const schedules: TriggerRegistration[] = []
  const approvals: Array<{ id: string; createdAt: string; request: unknown }> = []
  const service = new DashboardService({
    runStore: store,
    listWorkflows: () => workflows,
    listSchedules: () => schedules,
    approvals: { list: () => approvals },
    version: '0.3.8-test',
    startedAt: now - 3 * HOUR,
    now: () => now,
    cacheTtlMs: opts.cacheTtlMs ?? 0,
  })
  return { store, workflows, schedules, approvals, now, service }
}

describe('DashboardService.overview', () => {
  it('returns zeros for an empty gateway', async () => {
    const { service, now } = fixture()
    const overview = await service.overview()
    expect(overview.gateway.status).toBe('running')
    expect(overview.gateway.version).toBe('0.3.8-test')
    expect(overview.gateway.uptimeMs).toBe(3 * HOUR)
    expect(overview.gateway.startedAt).toBe(now - 3 * HOUR)
    expect(overview.workflows.total).toBe(0)
    expect(overview.runs.total).toBe(0)
    expect(overview.runs.avgDurationMs).toBeNull()
    expect(overview.schedules.total).toBe(0)
    expect(overview.approvals.pending).toBe(0)
    expect(overview.errors.last24h).toBe(0)
  })

  it('aggregates runs, errors, schedules, approvals', async () => {
    const f = fixture()
    await f.store.putRun(
      makeRun({ runId: 'r1', startedAt: f.now - 1 * HOUR, completedAt: f.now - 1 * HOUR + 200 }),
    )
    await f.store.putRun(
      makeRun({
        runId: 'r2',
        startedAt: f.now - 2 * HOUR,
        completedAt: f.now - 2 * HOUR + 600,
        status: 'failed',
        error: { name: 'Boom', message: 'kapow' },
      }),
    )
    await f.store.putRun(
      makeRun({
        runId: 'r3',
        startedAt: f.now - 2 * DAY,
        completedAt: f.now - 2 * DAY + 100,
      }),
    )
    f.workflows.push({ id: 'wf-a', path: '/abs/wf-a.workflow.ts' })
    f.schedules.push({
      spec: { kind: 'cron', id: 's1', workflowId: 'wf-a', cron: '* * * * *' },
      overlap: 'skip',
      fired: 4,
      inflight: true,
      lastError: 'oops',
    })
    f.approvals.push({
      id: 'r2:step',
      createdAt: new Date(f.now - 10 * 60 * 1000).toISOString(),
      request: { stepId: 'step' },
    })

    const overview = await f.service.overview()
    expect(overview.runs.total).toBe(3)
    expect(overview.runs.byStatus.completed).toBe(2)
    expect(overview.runs.byStatus.failed).toBe(1)
    expect(overview.runs.last24h).toBe(2)
    expect(overview.runs.avgDurationMs).toBe(300)
    expect(overview.errors.last24h).toBe(1)
    expect(overview.errors.recent).toHaveLength(1)
    expect(overview.errors.recent[0]?.message).toBe('kapow')
    expect(overview.workflows.total).toBe(1)
    expect(overview.workflows.withRecentFailures).toBe(1)
    expect(overview.schedules.total).toBe(1)
    expect(overview.schedules.inflight).toBe(1)
    expect(overview.schedules.withErrors).toBe(1)
    expect(overview.approvals.pending).toBe(1)
    expect(overview.approvals.oldestPendingAgeMs).toBe(10 * 60 * 1000)
  })

  it('caches overview within the TTL window', async () => {
    const f = fixture({ cacheTtlMs: 60_000 })
    const first = await f.service.overview()
    await f.store.putRun(makeRun({ runId: 'r1' }))
    const second = await f.service.overview()
    expect(second).toEqual(first)
    f.service.clearCache()
    const third = await f.service.overview()
    expect(third.runs.total).toBe(1)
  })
})

describe('DashboardService.workflowStats', () => {
  it('returns per-workflow stats joined to run history', async () => {
    const f = fixture()
    f.workflows.push({ id: 'wf-a', path: '/abs/wf-a.ts' })
    f.workflows.push({ id: 'wf-b', path: '/abs/wf-b.ts' })
    await f.store.putRun(makeRun({ runId: 'a1', pipelineId: 'wf-a', startedAt: 2 }))
    await f.store.putRun(
      makeRun({ runId: 'a2', pipelineId: 'wf-a', startedAt: 1, status: 'failed' }),
    )
    const stats = await f.service.workflowStats()
    const a = stats.find((s) => s.id === 'wf-a')
    const b = stats.find((s) => s.id === 'wf-b')
    expect(a?.totalRuns).toBe(2)
    expect(a?.successRate).toBe(0.5)
    expect(a?.lastStatus).toBe('completed')
    expect(a?.lastRunAt).toBe(2)
    expect(b?.totalRuns).toBe(0)
    expect(b?.successRate).toBeNull()
  })
})

describe('DashboardService.listRuns', () => {
  it('forwards filters to the run store', async () => {
    const f = fixture()
    await f.store.putRun(
      makeRun({ runId: 'r1', startedAt: 100, completedAt: 150, pipelineId: 'wf-a' }),
    )
    await f.store.putRun(
      makeRun({ runId: 'r2', startedAt: 200, completedAt: 700, pipelineId: 'wf-a' }),
    )
    await f.store.putRun(
      makeRun({ runId: 'r3', startedAt: 300, completedAt: 400, pipelineId: 'wf-b' }),
    )

    const all = await f.service.listRuns({})
    expect(all.map((r) => r.runId).sort()).toEqual(['r1', 'r2', 'r3'])

    const byWf = await f.service.listRuns({ workflowId: 'wf-a' })
    expect(byWf.map((r) => r.runId).sort()).toEqual(['r1', 'r2'])

    const byDate = await f.service.listRuns({ dateFrom: 150, dateTo: 250 })
    expect(byDate.map((r) => r.runId)).toEqual(['r2'])

    expect(byDate[0]?.durationMs).toBe(500)
  })
})

describe('DashboardService.analytics', () => {
  it('buckets runs by hour and computes counts', async () => {
    const f = fixture()
    // Hour-aligned epoch so bucket boundaries match `dateFrom`/`dateTo`.
    const t0 = Math.floor(1_700_000_000_000 / HOUR) * HOUR
    await f.store.putRun(makeRun({ runId: 'a', startedAt: t0 + 1 * HOUR + 60 }))
    await f.store.putRun(makeRun({ runId: 'b', startedAt: t0 + 1 * HOUR + 120 }))
    await f.store.putRun(makeRun({ runId: 'c', startedAt: t0 + 3 * HOUR + 30 }))

    const analytics = await f.service.analytics({
      metric: 'runs-per-hour',
      resolution: 'hour',
      dateFrom: t0,
      dateTo: t0 + 4 * HOUR,
    })
    expect(analytics.points).toHaveLength(4)
    expect(analytics.points.map((p) => p.value)).toEqual([0, 2, 0, 1])
  })

  it('computes success-rate per bucket', async () => {
    const f = fixture()
    // Hour-aligned epoch so bucket boundaries match `dateFrom`/`dateTo`.
    const t0 = Math.floor(1_700_000_000_000 / HOUR) * HOUR
    await f.store.putRun(makeRun({ runId: 'a', startedAt: t0 + 60, status: 'completed' }))
    await f.store.putRun(makeRun({ runId: 'b', startedAt: t0 + 120, status: 'failed' }))

    const analytics = await f.service.analytics({
      metric: 'success-rate',
      resolution: 'hour',
      dateFrom: t0,
      dateTo: t0 + HOUR,
    })
    expect(analytics.points[0]?.value).toBe(0.5)
  })
})

describe('DashboardService.errors', () => {
  it('returns failed runs and groups them by message', async () => {
    const f = fixture()
    await f.store.putRun(
      makeRun({
        runId: 'f1',
        startedAt: f.now - HOUR,
        status: 'failed',
        error: { name: 'X', message: 'boom' },
      }),
    )
    await f.store.putRun(
      makeRun({
        runId: 'f2',
        startedAt: f.now - 2 * HOUR,
        status: 'failed',
        error: { name: 'X', message: 'boom' },
      }),
    )
    await f.store.putRun(
      makeRun({
        runId: 'f3',
        startedAt: f.now - 30 * 60 * 1000,
        status: 'failed' as RunStatus,
        error: { name: 'Y', message: 'other' },
      }),
    )

    const errors = await f.service.errors()
    expect(errors.last24h).toBe(3)
    expect(errors.recent).toHaveLength(3)
    const boomGroup = errors.topGroups.find((g) => g.message === 'boom')
    expect(boomGroup?.count).toBe(2)
  })
})

describe('DashboardService.schedules / .approvals', () => {
  it('maps schedules to status entries', () => {
    const f = fixture()
    f.schedules.push({
      spec: { kind: 'interval', id: 's1', workflowId: 'wf-a', everyMs: 1000 },
      overlap: 'skip',
      fired: 3,
      inflight: false,
      lastFiredAt: '2026-05-13T12:00:00Z',
    })
    const out = f.service.schedules()
    expect(out).toEqual([
      {
        id: 's1',
        kind: 'interval',
        workflowId: 'wf-a',
        fired: 3,
        inflight: false,
        queued: 0,
        dropped: 0,
        runningCount: 0,
        lastFiredAt: '2026-05-13T12:00:00Z',
        nextFireAt: null,
        lastOutcome: null,
        lastOverlapDecision: null,
        lastError: null,
        lastErrorAt: null,
      },
    ])
  })

  it('reports oldest pending approval age', () => {
    const f = fixture()
    f.approvals.push({
      id: 'a1',
      createdAt: new Date(f.now - 5_000).toISOString(),
      request: {},
    })
    f.approvals.push({
      id: 'a2',
      createdAt: new Date(f.now - 50_000).toISOString(),
      request: {},
    })
    const out = f.service.approvals()
    expect(out.pendingCount).toBe(2)
    expect(out.oldestPendingAgeMs).toBe(50_000)
  })
})
