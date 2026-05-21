import { describe, expect, it, vi } from 'vitest'
import { createIntervalTrigger } from '../src/builders.js'
import { Scheduler } from '../src/scheduler.js'

// Runtime-level coverage of trigger firing and stop-drain. The existing
// scheduler.test.ts covers builder shapes and registry calls; this one
// asserts the timer/inflight contract: stop() awaits in-flight callbacks
// and the executed pipeline is loaded + the run is recorded.

function makeDeps(opts: { slowPut?: number } = {}) {
  const putRun = vi.fn(async () => {
    if (opts.slowPut !== undefined) await new Promise((r) => setTimeout(r, opts.slowPut))
  })
  const pipelineLoader = vi.fn(async () => ({ id: 'p' }))
  return { runStore: { putRun }, pipelineLoader }
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
    // Custom helper: track called-vs-resolved counters so we can assert
    // that stop() actually awaits in-flight putRun calls instead of
    // returning while the slow promises are still settling.
    let called = 0
    let resolved = 0
    const runStore = {
      putRun: async () => {
        called += 1
        await new Promise((r) => setTimeout(r, 80))
        resolved += 1
      },
    }
    const pipelineLoader = async () => ({ id: 'p' })
    const scheduler = new Scheduler({}, { runStore, pipelineLoader })
    await scheduler.register(createIntervalTrigger('slow', 'p', 10))
    await new Promise((r) => setTimeout(r, 30))
    const before = called
    expect(before).toBeGreaterThan(0)
    await scheduler.stop()
    // Without drain, `resolved < called` would be true here because the
    // 80ms putRun promises would not have settled yet.
    expect(resolved).toBeGreaterThanOrEqual(before)
  })

  it('overlap=fail-fast skips firings while a previous run is in flight', async () => {
    let called = 0
    const runStore = {
      putRun: async () => {
        called += 1
        await new Promise((r) => setTimeout(r, 60))
      },
    }
    const pipelineLoader = async () => ({ id: 'p' })
    const scheduler = new Scheduler({}, { runStore, pipelineLoader })
    await scheduler.register({
      id: 'ff',
      type: 'interval',
      pipelineId: 'p',
      intervalMs: 10,
      enabled: true,
      overlap: 'fail-fast',
    })
    await new Promise((r) => setTimeout(r, 50))
    // Without fail-fast, ~5 firings would land in 50ms. With it, only 1.
    expect(called).toBe(1)
    await scheduler.stop()
  })

  it('overlap=wait chains firings serially', async () => {
    const starts: number[] = []
    const runStore = {
      putRun: async () => {
        starts.push(Date.now())
        await new Promise((r) => setTimeout(r, 40))
      },
    }
    const pipelineLoader = async () => ({ id: 'p' })
    const scheduler = new Scheduler({}, { runStore, pipelineLoader })
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
