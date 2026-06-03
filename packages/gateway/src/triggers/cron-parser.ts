import parser from 'cron-parser'

export interface ParsedCron {
  expression: string
  tz?: string
  dayOfMonth?: readonly number[]
  dayOfWeek?: readonly number[]
  impossibleDayOfMonth?: true
}

/**
 * How far `nextFireTime` looks ahead for the next match. A cron whose next
 * fire is beyond this window returns null — note that this means null is
 * "no fire within the horizon", NOT "never fires": a valid but sparse cron
 * (e.g. `0 0 29 2 *`, whose next Feb 29 can be years out) also returns null.
 * Callers that arm a timer must therefore re-check at the horizon rather than
 * treat null as a dead trigger (see TriggerCoordinator.scheduleNextCron).
 */
export const CRON_LOOKAHEAD_MS = 366 * 24 * 60 * 60 * 1000

export function parseCron(expr: string, tz?: string): ParsedCron | null {
  const expression = expr.trim()
  const parts = expression.split(/\s+/)
  if (parts.length !== 5 || parts.some((part) => part === '')) return null
  if (tz !== undefined && !isValidTimezone(tz)) return null
  if (hasUnsupportedFieldNames(parts) || dayOfWeekAllowsSeven(parts[4] ?? '')) return null

  try {
    const interval = parser.parseExpression(expression, { ...(tz !== undefined && { tz }) })
    return {
      expression,
      ...(tz !== undefined && { tz }),
      ...(requiresDayAnd(interval.fields) && {
        dayOfMonth: numericValues(interval.fields.dayOfMonth),
        dayOfWeek: numericValues(interval.fields.dayOfWeek),
      }),
    }
  } catch (err) {
    if (isImpossibleDayOfMonth(err)) {
      return tz !== undefined
        ? { expression, tz, impossibleDayOfMonth: true }
        : { expression, impossibleDayOfMonth: true }
    }
    return null
  }
}

export function nextFireTime(parsed: ParsedCron, from: Date): Date | null {
  if (parsed.impossibleDayOfMonth === true) return null
  const cap = from.getTime() + CRON_LOOKAHEAD_MS

  try {
    const interval = parser.parseExpression(parsed.expression, {
      currentDate: from,
      ...(parsed.tz !== undefined && { tz: parsed.tz }),
    })
    while (true) {
      const next = interval.next().toDate()
      if (next.getTime() > cap) return null
      if (matchesDayFields(parsed, next)) return next
    }
  } catch {
    return null
  }
}

function requiresDayAnd(fields: { dayOfMonth: readonly unknown[]; dayOfWeek: readonly unknown[] }) {
  return fields.dayOfMonth.length < 31 && fields.dayOfWeek.length < 7
}

function numericValues(values: readonly unknown[]): number[] {
  return values.filter((value): value is number => typeof value === 'number')
}

function matchesDayFields(parsed: ParsedCron, date: Date): boolean {
  if (parsed.dayOfMonth === undefined || parsed.dayOfWeek === undefined) return true
  const fields =
    parsed.tz !== undefined
      ? getDayFieldsInTz(date, parsed.tz)
      : { dayOfMonth: date.getDate(), dayOfWeek: date.getDay() }
  return (
    parsed.dayOfMonth.includes(fields.dayOfMonth) && parsed.dayOfWeek.includes(fields.dayOfWeek)
  )
}

function getDayFieldsInTz(date: Date, tz: string): { dayOfMonth: number; dayOfWeek: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  )
  const weekday = parts.weekday
  const dayOfWeek = weekday !== undefined ? WEEKDAY_TO_INDEX[weekday] : undefined
  if (dayOfWeek === undefined) throw new RangeError(`unable to resolve weekday for timezone: ${tz}`)
  return { dayOfMonth: Number(parts.day), dayOfWeek }
}

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function hasUnsupportedFieldNames(parts: readonly string[]): boolean {
  return /[a-z]/i.test(parts[3] ?? '') || /[a-z]/i.test(parts[4] ?? '')
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function dayOfWeekAllowsSeven(field: string): boolean {
  for (const segment of field.split(',')) {
    const range = segment.split('/')[0]
    if (range === undefined || range === '*') continue
    const values = range.includes('-') ? range.split('-') : [range]
    for (const value of values) {
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n) && n > 6) return true
    }
  }
  return false
}

function isImpossibleDayOfMonth(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Invalid explicit day of month definition')
}
