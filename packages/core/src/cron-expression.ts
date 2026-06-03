import parser from 'cron-parser'

export interface ParsedCronExpression {
  expression: string
  timezone?: string
  dayOfMonth?: readonly number[]
  dayOfWeek?: readonly number[]
  impossibleDayOfMonth?: true
}

/**
 * How far `nextCronFireTime` looks ahead for the next match. A cron whose next
 * fire is beyond this window returns null, so callers that arm timers should
 * re-check at the horizon rather than treat null as a dead trigger.
 */
export const CRON_LOOKAHEAD_MS = 366 * 24 * 60 * 60 * 1000

export function parseCronExpression(expr: string, timezone?: string): ParsedCronExpression | null {
  const expression = expr.trim()
  const parts = expression.split(/\s+/)
  if (parts.length !== 5 || parts.some((part) => part === '')) return null
  if (timezone !== undefined && !isValidTimezone(timezone)) return null
  if (hasUnsupportedFieldNames(parts) || dayOfWeekAllowsSeven(parts[4] ?? '')) return null

  try {
    const interval = parser.parseExpression(expression, {
      ...(timezone !== undefined && { tz: timezone }),
    })
    return {
      expression,
      ...(timezone !== undefined && { timezone }),
      ...(requiresDayAnd(interval.fields) && {
        dayOfMonth: numericValues(interval.fields.dayOfMonth),
        dayOfWeek: numericValues(interval.fields.dayOfWeek),
      }),
    }
  } catch (err) {
    if (isImpossibleDayOfMonth(err)) {
      return timezone !== undefined
        ? { expression, timezone, impossibleDayOfMonth: true }
        : { expression, impossibleDayOfMonth: true }
    }
    return null
  }
}

export function nextCronFireTime(parsed: ParsedCronExpression, from: Date): Date | null {
  if (parsed.impossibleDayOfMonth === true) return null
  const cap = from.getTime() + CRON_LOOKAHEAD_MS

  try {
    const interval = parser.parseExpression(parsed.expression, {
      currentDate: from,
      ...(parsed.timezone !== undefined && { tz: parsed.timezone }),
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

function matchesDayFields(parsed: ParsedCronExpression, date: Date): boolean {
  if (parsed.dayOfMonth === undefined || parsed.dayOfWeek === undefined) return true
  const fields =
    parsed.timezone !== undefined
      ? getDayFieldsInTz(date, parsed.timezone)
      : { dayOfMonth: date.getDate(), dayOfWeek: date.getDay() }
  return (
    parsed.dayOfMonth.includes(fields.dayOfMonth) && parsed.dayOfWeek.includes(fields.dayOfWeek)
  )
}

function getDayFieldsInTz(date: Date, timezone: string): { dayOfMonth: number; dayOfWeek: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  )
  const weekday = parts.weekday
  const dayOfWeek = weekday !== undefined ? WEEKDAY_TO_INDEX[weekday] : undefined
  if (dayOfWeek === undefined) {
    throw new RangeError(`unable to resolve weekday for timezone: ${timezone}`)
  }
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

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
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
