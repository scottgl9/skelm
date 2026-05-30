import { MAX_INTERVAL_MS } from './pipeline-trigger-to-spec.js'

/**
 * A setTimeout replacement that honors arbitrarily-distant delays.
 *
 * Node's setTimeout clamps any delay above 2^31-1 ms (~24.8 days) — or <= 0 —
 * down to 1ms. A naive `setTimeout(fn, monthsFromNow)` therefore fires
 * IMMEDIATELY instead of at the scheduled time. For a one-shot `at` trigger
 * that is a correctness bug; for a self-rescheduling cron timer it degrades
 * into a ~1ms tight loop that fires the workflow ~1000x/second — a denial of
 * service (the same failure class the interval/poll `everyMs` guard prevents,
 * but on the timeout-arming paths the spec-level guard cannot reach because a
 * far-future cron/at delay is computed at arm time, not declared).
 *
 * LongTimer arms the delay in <= MAX_INTERVAL_MS chunks, re-arming until the
 * real delay has elapsed, then invokes `fn` exactly once. Each underlying
 * timer is unref'd so an armed far-future trigger never keeps the process
 * alive. `clear()` cancels whichever chunk is currently pending.
 */
export class LongTimer {
  private timer: NodeJS.Timeout | undefined
  private remaining: number

  constructor(
    delayMs: number,
    private readonly fn: () => void,
  ) {
    this.remaining = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0
    this.arm()
  }

  private arm(): void {
    const chunk = Math.min(this.remaining, MAX_INTERVAL_MS)
    this.remaining -= chunk
    this.timer = setTimeout(() => {
      if (this.remaining > 0) {
        this.arm()
      } else {
        this.fn()
      }
    }, chunk)
    this.timer.unref?.()
  }

  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}
