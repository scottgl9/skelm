import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TriggerCoordinator } from '../src/index.js'

// Regression: a valid but sparse cron whose next fire is beyond nextFireTime's
// 366-day lookahead (e.g. `0 0 29 2 *` — next Feb 29 can be years out) made
// nextFireTime return null, and scheduleNextCron treated null as "dead" and
// silently never armed it. The cron was accepted at registration (HTTP 200,
// listed, no error) yet would never fire. scheduleNextCron now re-checks at the
// horizon so the fire is armed once it comes within range.
describe('sparse cron horizon re-arm (leap-day silently-never-fires)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('eventually fires a leap-day cron whose next fire is beyond the lookahead', async () => {
    const fires: string[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void fires.push(ctx.workflowId) })
    c.register({ kind: 'cron', id: 'leap', workflowId: 'leap-wf', cron: '0 0 29 2 *' })

    // Within the first lookahead window it must be armed but NOT fire (and must
    // certainly not tight-loop, the #265 failure mode).
    await vi.advanceTimersByTimeAsync(300 * 24 * 60 * 60 * 1000)
    expect(fires).toHaveLength(0)

    // Advance past the next real Feb 29 (2028-02-29). The horizon re-check
    // re-scans, finds the in-range fire, and arms it.
    await vi.advanceTimersByTimeAsync(640 * 24 * 60 * 60 * 1000)
    expect(fires).toEqual(['leap-wf'])

    await c.stop()
  })

  it('does not fire an impossible cron (Feb 30) — re-checks harmlessly', async () => {
    const fires: string[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void fires.push(ctx.workflowId) })
    c.register({ kind: 'cron', id: 'never', workflowId: 'never-wf', cron: '0 0 30 2 *' })
    // Three+ horizon windows: still zero fires, no tight loop.
    await vi.advanceTimersByTimeAsync(3 * 366 * 24 * 60 * 60 * 1000)
    expect(fires).toHaveLength(0)
    await c.stop()
  })
})
