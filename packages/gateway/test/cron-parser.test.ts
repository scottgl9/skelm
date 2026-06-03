import { describe, expect, it } from 'vitest'
import { nextFireTime, parseCron } from '../src/triggers/cron-parser.js'

// Slim ICU builds (e.g. `node --icu-data-dir=…` containers) ship only the
// English locale and no zone offsets, which makes `Intl.DateTimeFormat` either
// throw on a named tz or silently fall back to UTC. Skip the tz suite when
// that's the case so the test reports the cause instead of a confusing
// assertion failure.
const hasFullIcu = (() => {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York' })
    return fmt.resolvedOptions().timeZone === 'America/New_York'
  } catch {
    return false
  }
})()
const itTz = hasFullIcu ? it : it.skip

describe('parseCron', () => {
  it('rejects expressions with the wrong number of fields', () => {
    expect(parseCron('* * * *')).toBeNull()
    expect(parseCron('* * * * * *')).toBeNull()
    expect(parseCron('')).toBeNull()
  })

  it('accepts wildcards', () => {
    expect(parseCron('* * * * *')).not.toBeNull()
  })

  it('accepts step values from a wildcard base', () => {
    expect(parseCron('*/15 * * * *')).not.toBeNull()
  })

  it('accepts ranges and lists', () => {
    expect(parseCron('1,5,10-12 9-17 * * 1-5')).not.toBeNull()
  })

  it('rejects out-of-range values', () => {
    expect(parseCron('60 * * * *')).toBeNull()
    expect(parseCron('* 24 * * *')).toBeNull()
    expect(parseCron('* * 0 * *')).toBeNull()
    expect(parseCron('* * * 13 *')).toBeNull()
    expect(parseCron('* * * * 7')).toBeNull()
  })

  it('preserves the five-field numeric contract', () => {
    expect(parseCron('0 9 * jan *')).toBeNull()
    expect(parseCron('0 9 * * mon')).toBeNull()
  })

  it('rejects step <= 0', () => {
    expect(parseCron('*/0 * * * *')).toBeNull()
    expect(parseCron('*/-1 * * * *')).toBeNull()
  })
})

describe('nextFireTime', () => {
  it('finds the next minute matching a wildcard', () => {
    const p = parseCron('* * * * *')
    const from = new Date('2026-05-04T10:30:15.500Z')
    const next = nextFireTime(p as never, from)
    expect(next?.toISOString()).toBe('2026-05-04T10:31:00.000Z')
  })

  it('respects step values', () => {
    const p = parseCron('*/15 * * * *')
    const from = new Date('2026-05-04T10:32:00.000Z')
    const next = nextFireTime(p as never, from)
    expect(next?.getMinutes()).toBe(45)
  })

  it('crosses hour boundaries when the current hour has no matches left', () => {
    const p = parseCron('5 * * * *') // minute 5 of every hour
    const from = new Date('2026-05-04T10:30:00.000Z')
    const next = nextFireTime(p as never, from)
    expect(next?.toISOString()).toBe('2026-05-04T11:05:00.000Z')
  })

  it('honors day-of-week filters (local-time semantics)', () => {
    // Monday only at minute 0. parseCron uses local time; pick a clearly
    // post-Monday-9am moment so the next match is the following Monday.
    const p = parseCron('0 9 * * 1')
    // 2026-05-05 was a Tuesday in any timezone; minute 0 hour 9 next match
    // is the following Monday 2026-05-11.
    const from = new Date('2026-05-05T20:00:00.000Z')
    const next = nextFireTime(p as never, from)
    expect(next).not.toBeNull()
    expect(next?.getDay()).toBe(1) // local Monday
    expect(next?.getHours()).toBe(9) // local 09:00
    expect(next?.getMinutes()).toBe(0)
  })

  it('requires day-of-month and day-of-week to both match', () => {
    const p = parseCron('0 9 13 * 5')
    const next = nextFireTime(p as never, new Date(2026, 2, 14, 12, 0, 0, 0))

    expect(next).not.toBeNull()
    expect(next?.getFullYear()).toBe(2026)
    expect(next?.getMonth()).toBe(10)
    expect(next?.getDate()).toBe(13)
    expect(next?.getDay()).toBe(5)
    expect(next?.getHours()).toBe(9)
    expect(next?.getMinutes()).toBe(0)
  })

  it('returns null for impossible expressions (Feb 30)', () => {
    const p = parseCron('0 0 30 2 *')
    const from = new Date('2026-01-01T00:00:00.000Z')
    expect(nextFireTime(p as never, from)).toBeNull()
  })

  it('null is "no fire within the lookahead", NOT "never fires" (leap-day cron)', () => {
    // `0 0 29 2 *` is a VALID, fireable cron — Feb 29 exists in leap years.
    // From 2026 the next Feb 29 (2028) is ~639 days out, beyond the 366-day
    // lookahead, so nextFireTime returns null. That null must NOT be treated as
    // "dead": from a date within range of 2028-02-29 it resolves correctly.
    // (TriggerCoordinator.scheduleNextCron re-checks at the horizon for this.)
    const p = parseCron('0 0 29 2 *')
    expect(p).not.toBeNull()
    expect(nextFireTime(p as never, new Date('2026-05-30T00:00:00.000Z'))).toBeNull()
    const within = nextFireTime(p as never, new Date('2028-01-01T00:00:00.000Z'))
    // Local-time assertion (cron `0 0` is local midnight) — TZ-robust.
    expect(within).not.toBeNull()
    expect(within?.getFullYear()).toBe(2028)
    expect(within?.getMonth()).toBe(1) // February (0-indexed)
    expect(within?.getDate()).toBe(29)
  })

  itTz('projects cron matching into the requested timezone', () => {
    const winter = parseCron('0 9 * * *', 'America/New_York')
    const summer = parseCron('0 9 * * *', 'America/New_York')
    expect(winter).not.toBeNull()
    expect(summer).not.toBeNull()

    // 09:00 America/New_York is 14:00 UTC in winter (EST, UTC-5) and 13:00
    // UTC in summer (EDT, UTC-4). Same cron string, different absolute time —
    // proves the tz projection is doing real work.
    const winterNext = nextFireTime(winter as never, new Date('2026-01-15T13:30:00.000Z'))
    const summerNext = nextFireTime(summer as never, new Date('2026-07-15T12:30:00.000Z'))

    expect(winterNext?.toISOString()).toBe('2026-01-15T14:00:00.000Z')
    expect(summerNext?.toISOString()).toBe('2026-07-15T13:00:00.000Z')
  })

  itTz('returns null for an invalid timezone name', () => {
    expect(parseCron('0 9 * * *', 'Not/A_Real_Timezone')).toBeNull()
  })

  it('omitting tz preserves the prior local-time behavior', () => {
    const p = parseCron('0 9 * * *')
    const from = new Date('2026-05-05T20:00:00.000Z')
    const next = nextFireTime(p as never, from)
    expect(next).not.toBeNull()
    expect(next?.getHours()).toBe(9)
    expect(next?.getMinutes()).toBe(0)
  })
})
