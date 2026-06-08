import { describe, expect, it, vi } from 'vitest'
import { createIntervalTrigger } from '../src/builders.js'
import { Scheduler } from '../src/scheduler.js'

// Runtime-level coverage of trigger firing and stop-drain. The existing
// scheduler.test.ts covers builder shapes and registry calls; this one
// asserts the timer/inflight contract: stop() awaits in-flight callbacks
// and the executed pipeline is loaded + the run is recorded.

function makeRun(pipelineId: string, opts: { fail?: boolean } = {}) {
  return {
    runId: `r-${Date.now()}-${Math.random()}`,
    pipelineId,
    input: {},
    status: opts.fail === true ? ('failed' as const) : ('completed' as const),
    steps: [],
    output: opts.fail === true ? undefined : { ok: true },
    error: opts.fail === true ? { name: 'Error', message: 'simulated' } : undefined,
    startedAt: Date.now(),
    completedAt: Date.now(),
  }
}

function makeDeps(opts: { slowPut?: number } = {}) {
  const putRun = vi.fn(async () => {
    if (opts.slowPut !== undefined) await new Promise((r) => setTimeout(r, opts.slowPut))
  })
  const pipelineLoader = vi.fn(async () => ({ id: 'p' }))
  const pipelineExecutor = vi.fn(async (pipeline: { id: string }) => makeRun(pipeline.id))
  return { runStore: { putRun }, pipelineLoader, pipelineExecutor }
}

describe('Scheduler — runtime', () => {
  it('fires an interval trigger and records a run', async () => {
    const deps = makeDeps()
    const scheduler = new Scheduler({}, deps)
    const trigger = createIntervalTrigger('t', 'p', 20)
    await scheduler.register(trigger)
    await new Promise((r) => setTimeout(r, 60))
    await scheduler.stop()
    expect(deps.runStore.putRun).toHaveBeenCalled()
    expect(deps.pipelineLoader).toHaveBeenCalledWith('p')
    const reg = scheduler.getTrigger('t')
    expect(reg?.runCount ?? 0).toBeGreaterThan(0)
  })

  it('stop() drains in-flight executions before resolving', async () => {
    let called = 0
    let resolved = 0
    const runStore = { putRun: async () => {} }
    const pipelineLoader = async () => ({ id: 'p' })
    const pipelineExecutor = async (pipeline: { id: string }) => {
      called += 1
      await new Promise((r) => setTimeout(r, 80))
      resolved += 1
      return makeRun(pipeline.id)
    }
    const scheduler = new Scheduler({}, { runStore, pipelineLoader, pipelineExecutor })
    await scheduler.register(createIntervalTrigger('slow', 'p', 10))
    await new Promise((r) => setTimeout(r, 30))
    const before = called
    expect(before).toBeGreaterThan(0)
    await scheduler.stop()
    expect(resolved).toBeGreaterThanOrEqual(before)
  })

  it('overlap=fail-fast skips firings while a previous run is in flight', async () => {
    let called = 0
    const runStore = { putRun: async () => {} }
    const pipelineLoader = async () => ({ id: 'p' })
    const pipelineExecutor = async (pipeline: { id: string }) => {
      called += 1
      await new Promise((r) => setTimeout(r, 60))
      return makeRun(pipeline.id)
    }
    const scheduler = new Scheduler({}, { runStore, pipelineLoader, pipelineExecutor })
    await scheduler.register({
      id: 'ff',
      type: 'interval',
      pipelineId: 'p',
      intervalMs: 10,
      enabled: true,
      overlap: 'fail-fast',
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(called).toBe(1)
    expect(scheduler.getTrigger('ff')?.lastOutcome).toBe('skipped')
    await scheduler.stop()
  })

  it('overlap=wait chains firings serially', async () => {
    const starts: number[] = []
    const runStore = { putRun: async () => {} }
    const pipelineLoader = async () => ({ id: 'p' })
    const pipelineExecutor = async (pipeline: { id: string }) => {
      starts.push(Date.now())
      await new Promise((r) => setTimeout(r, 40))
      return makeRun(pipeline.id)
    }
    const scheduler = new Scheduler({}, { runStore, pipelineLoader, pipelineExecutor })
    await scheduler.register({
      id: 'w',
      type: 'interval',
      pipelineId: 'p',
      intervalMs: 10,
      enabled: true,
      overlap: 'wait',
    })
    await new Promise((r) => setTimeout(r, 100))
    await scheduler.stop()
    expect(starts.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < starts.length; i++) {
      const start = starts[i] as number
      const prev = starts[i - 1] as number
      expect(start - prev).toBeGreaterThanOrEqual(35)
    }
  })

  it('without a pipelineExecutor, fires warn once per trigger and do NOT persist a stub Run', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const putRun = vi.fn(async () => {})
    const pipelineLoader = vi.fn(async () => ({ id: 'p' }))
    const scheduler = new Scheduler({}, { runStore: { putRun }, pipelineLoader })
    await scheduler.register(createIntervalTrigger('no-exec', 'p', 10))
    await new Promise((r) => setTimeout(r, 50))
    await scheduler.stop()
    // The orphan-run bug was: putRun called with status='running' and no
    // completion. Fixed by skipping putRun when no executor is wired.
    expect(putRun).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    // Warn only once per trigger even after many fires.
    const noExecWarnings = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('no pipelineExecutor'),
    )
    expect(noExecWarnings).toHaveLength(1)
    warnSpy.mockRestore()
  })

  it('supports legacy deps-only construction, legacy cron registration, and direct fire(id)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const putRun = vi.fn(async () => {})
    const scheduler = new Scheduler({ runStore: { putRun } })
    await scheduler.register({
      id: 'legacy',
      kind: 'cron',
      cron: '0 0 1 1 *',
      workflowId: 'noop',
    })
    scheduler.fire('legacy')
    scheduler.fire('legacy')
    await scheduler.stop()

    expect(putRun).not.toHaveBeenCalled()
    const noExecWarnings = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('no pipelineExecutor'),
    )
    expect(noExecWarnings).toHaveLength(1)
    expect(scheduler.getTrigger('legacy')?.runCount).toBe(2)
    warnSpy.mockRestore()
  })

  it('preserves trigger-specific fields when registering legacy trigger shapes', async () => {
    const putRun = vi.fn(async () => {})
    const scheduler = new Scheduler({ runStore: { putRun } })
    const transformPayload = (payload: unknown) => ({ wrapped: payload })

    await scheduler.register({
      id: 'legacy-cron',
      kind: 'cron',
      cron: '0 9 * * *',
      timezone: 'America/Chicago',
      workflowId: 'noop',
    })
    await scheduler.register({
      id: 'legacy-interval',
      kind: 'interval',
      intervalMs: 60_000,
      initialDelayMs: 5_000,
      workflowId: 'noop',
    })
    await scheduler.register({
      id: 'legacy-webhook',
      kind: 'webhook',
      path: '/hooks/legacy',
      secret: 'test-secret',
      transformPayload,
      workflowId: 'noop',
    })

    expect(scheduler.getTrigger('legacy-cron')?.trigger).toMatchObject({
      type: 'cron',
      schedule: '0 9 * * *',
      timezone: 'America/Chicago',
    })
    expect(scheduler.getTrigger('legacy-interval')?.trigger).toMatchObject({
      type: 'interval',
      intervalMs: 60_000,
      initialDelayMs: 5_000,
    })
    expect(scheduler.getTrigger('legacy-webhook')?.trigger).toMatchObject({
      type: 'webhook',
      path: '/hooks/legacy',
      secret: 'test-secret',
      transformPayload,
    })

    await scheduler.stop()
  })

  it('honors legacy interval initialDelayMs before the first fire', async () => {
    const deps = makeDeps()
    const scheduler = new Scheduler({}, deps)
    await scheduler.register({
      id: 'delayed',
      kind: 'interval',
      intervalMs: 20,
      initialDelayMs: 80,
      workflowId: 'p',
    })

    await new Promise((r) => setTimeout(r, 45))
    expect(deps.pipelineExecutor).not.toHaveBeenCalled()

    await new Promise((r) => setTimeout(r, 70))
    await scheduler.stop()
    expect(deps.pipelineExecutor).toHaveBeenCalled()
  })

  it('persists the Run returned by pipelineExecutor and marks status=error on failure', async () => {
    const putRun = vi.fn(async () => {})
    const pipelineLoader = vi.fn(async () => ({ id: 'p' }))
    const pipelineExecutor = vi.fn(async (pipeline: { id: string }) =>
      makeRun(pipeline.id, { fail: true }),
    )
    const scheduler = new Scheduler({}, { runStore: { putRun }, pipelineLoader, pipelineExecutor })
    await scheduler.register(createIntervalTrigger('exec', 'p', 10))
    await new Promise((r) => setTimeout(r, 30))
    await scheduler.stop()
    expect(pipelineExecutor).toHaveBeenCalled()
    expect(putRun).toHaveBeenCalled()
    const reg = scheduler.getTrigger('exec')
    expect(reg?.status).toBe('error')
    expect(reg?.lastError).toBe('simulated')
    expect(reg?.lastErrorAt).toEqual(expect.any(Number))
    expect(reg?.lastOutcome).toBe('failed')
  })

  it('pause stops firings and resume re-enables them', async () => {
    const deps = makeDeps()
    const scheduler = new Scheduler({}, deps)
    const trigger = createIntervalTrigger('p1', 'p', 20)
    await scheduler.register(trigger)
    await new Promise((r) => setTimeout(r, 30))
    await scheduler.pause('p1')
    const callsAfterPause = deps.runStore.putRun.mock.calls.length
    await new Promise((r) => setTimeout(r, 50))
    expect(deps.runStore.putRun.mock.calls.length).toBe(callsAfterPause)
    await scheduler.resume('p1')
    await new Promise((r) => setTimeout(r, 50))
    await scheduler.stop()
    expect(deps.runStore.putRun.mock.calls.length).toBeGreaterThan(callsAfterPause)
  })
})
