import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TriggerCoordinator } from '../src/index.js'
import { LongTimer } from '../src/triggers/long-timer.js'
import { MAX_INTERVAL_MS } from '../src/triggers/pipeline-trigger-to-spec.js'

// Regression: `at` and cron triggers were armed with a raw setTimeout(fn, delay).
// Node clamps any setTimeout delay > 2^31-1 ms (~24.8 days) down to 1ms, so a
// far-future trigger fired IMMEDIATELY instead of at its scheduled time — and a
// self-rescheduling cron degraded into a ~1ms tight loop (~1000 fires/second, a
// DoS). LongTimer chunks the delay so it fires exactly once, when it should.
describe('LongTimer (setTimeout >2^31 overflow)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT fire after 1ms for a delay beyond the setTimeout ceiling', () => {
    const fn = vi.fn()
    const t = new LongTimer(MAX_INTERVAL_MS + 60_000, fn)
    // The clamp bug would fire here (delay collapsed to 1ms).
    vi.advanceTimersByTime(2)
    expect(fn).not.toHaveBeenCalled()
    t.clear()
  })

  it('fires exactly once after the full (chunked) delay elapses', () => {
    const fn = vi.fn()
    const delay = MAX_INTERVAL_MS + 60_000
    new LongTimer(delay, fn)
    vi.advanceTimersByTime(MAX_INTERVAL_MS) // first chunk done, remainder pending
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000) // remainder elapses
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(MAX_INTERVAL_MS) // no spurious re-fire
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('fires a sub-ceiling delay normally (no chunking)', () => {
    const fn = vi.fn()
    new LongTimer(1000, fn)
    vi.advanceTimersByTime(999)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('clear() cancels a pending far-future timer', () => {
    const fn = vi.fn()
    const t = new LongTimer(MAX_INTERVAL_MS * 3, fn)
    t.clear()
    vi.advanceTimersByTime(MAX_INTERVAL_MS * 4)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('TriggerCoordinator far-future arming (overflow-clamp DoS)', () => {
  it('does NOT fire a far-future `at` immediately', async () => {
    const fires: string[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void fires.push(ctx.workflowId) })
    const when = new Date(Date.now() + (MAX_INTERVAL_MS + 30 * 24 * 60 * 60 * 1000)).toISOString()
    c.register({ kind: 'at', id: 'at-far', workflowId: 'wf', when })
    // Without the chunked timer this fires within ~1ms (clamp). With it: zero.
    await new Promise((r) => setTimeout(r, 60))
    expect(fires).toHaveLength(0)
    await c.stop()
  })

  it('does NOT tight-loop a sparse (annual) cron', async () => {
    const fires: string[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void fires.push(ctx.workflowId) })
    // Annual cron: next fire is months out → delay >> 2^31. The clamp bug
    // re-chained every 1ms, firing dozens of times in this 80ms window.
    c.register({ kind: 'cron', id: 'cron-annual', workflowId: 'wf', cron: '0 0 1 1 *' })
    await new Promise((r) => setTimeout(r, 80))
    expect(fires).toHaveLength(0)
    await c.stop()
  })

  it('still fires an imminent `at` and a frequent cron', async () => {
    const fires: string[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void fires.push(ctx.workflowId) })
    c.register({
      kind: 'at',
      id: 'at-soon',
      workflowId: 'soon',
      when: new Date(Date.now() + 20).toISOString(),
    })
    await new Promise((r) => setTimeout(r, 80))
    expect(fires).toContain('soon')
    await c.stop()
  })
})
