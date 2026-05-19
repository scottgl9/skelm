import { describe, expect, it } from 'vitest'
import { nextFireTime, parseCron } from '../src/triggers/cron-parser.js'

describe('parseCron', () => {
  it('rejects expressions with the wrong number of fields', () => {
    expect(parseCron('* * * *')).toBeNull()
    expect(parseCron('* * * * * *')).toBeNull()
    expect(parseCron('')).toBeNull()
  })

  it('parses wildcards into the full domain', () => {
    const p = parseCron('* * * * *')
    expect(p).not.toBeNull()
    expect(p?.minute.size).toBe(60)
    expect(p?.hour.size).toBe(24)
    expect(p?.month.size).toBe(12)
  })

  it('parses step values from a wildcard base', () => {
    const p = parseCron('*/15 * * * *')
    expect(Array.from(p?.minute ?? []).sort((a, b) => a - b)).toEqual([0, 15, 30, 45])
  })

  it('parses ranges and lists', () => {
    const p = parseCron('1,5,10-12 9-17 * * 1-5')
    expect(Array.from(p?.minute ?? []).sort((a, b) => a - b)).toEqual([1, 5, 10, 11, 12])
    expect(Array.from(p?.hour ?? []).sort((a, b) => a - b)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17,
    ])
    expect(Array.from(p?.dayOfWeek ?? []).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('rejects out-of-range values', () => {
    expect(parseCron('60 * * * *')).toBeNull()
    expect(parseCron('* 24 * * *')).toBeNull()
    expect(parseCron('* * 0 * *')).toBeNull()
    expect(parseCron('* * * 13 *')).toBeNull()
    expect(parseCron('* * * * 7')).toBeNull()
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

  it('returns null for impossible expressions (Feb 30)', () => {
    const p = parseCron('0 0 30 2 *')
    const from = new Date('2026-01-01T00:00:00.000Z')
    expect(nextFireTime(p as never, from)).toBeNull()
  })

  it('projects cron matching into the requested timezone', () => {
    const winter = parseCron('0 9 * * *', 'America/New_York')
    const summer = parseCron('0 9 * * *', 'America/New_York')
    expect(winter).not.toBeNull()
    expect(summer).not.toBeNull()

    const winterNext = nextFireTime(winter as never, new Date('2026-01-15T13:30:00.000Z'))
    const summerNext = nextFireTime(summer as never, new Date('2026-07-15T12:30:00.000Z'))

    expect(winterNext?.toISOString()).toBe('2026-01-15T14:00:00.000Z')
    expect(summerNext?.toISOString()).toBe('2026-07-15T13:00:00.000Z')
  })

  it('returns null for an invalid timezone name', () => {
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
