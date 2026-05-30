/**
 * Tiny cron parser sized for the trigger coordinator. Supports the standard
 * five-field syntax — minute, hour, day-of-month, month, day-of-week — with
 * wildcards, ranges, lists, and step values. Fully expressed as a precomputed
 * Set per field, so nextFireTime() is just a per-minute walk forward.
 *
 *  * * * * *
 *  │ │ │ │ │
 *  │ │ │ │ └─ day of week (0–6, Sunday=0)
 *  │ │ │ └─── month (1–12)
 *  │ │ └───── day of month (1–31)
 *  │ └─────── hour (0–23)
 *  └───────── minute (0–59)
 *
 * Supported patterns per field:
 *   *
 *   *\/N
 *   N
 *   N-M
 *   N-M\/K
 *   N,M,K
 *   any combination of the above separated by commas
 *
 * Names ('mon', 'tue', 'jan', ...) are not supported. Operators that need
 * them can pre-translate or pick a richer cron library and pass an
 * `everyMs`-style trigger instead.
 *
 * Optional `tz` (IANA timezone) projects the match into that zone via
 * `Intl.DateTimeFormat`. Omitting it preserves local-time semantics.
 */

export interface ParsedCron {
  minute: ReadonlySet<number>
  hour: ReadonlySet<number>
  dayOfMonth: ReadonlySet<number>
  month: ReadonlySet<number>
  dayOfWeek: ReadonlySet<number>
  tz?: string
}

type FieldName = Exclude<keyof ParsedCron, 'tz'>

const FIELDS: Array<{ name: FieldName; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
]

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function createTzFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  })
}

function getFieldsInTz(
  date: Date,
  tz: string,
): { minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number } {
  const parts = Object.fromEntries(
    createTzFormatter(tz)
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  )
  const weekday = parts.weekday
  const dayOfWeek = weekday !== undefined ? WEEKDAY_TO_INDEX[weekday] : undefined
  if (dayOfWeek === undefined) {
    throw new RangeError(`unable to resolve weekday for timezone: ${tz}`)
  }
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek,
  }
}

export function parseCron(expr: string, tz?: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  if (tz !== undefined) {
    try {
      createTzFormatter(tz)
    } catch {
      return null
    }
  }
  const out: Partial<Record<FieldName, ReadonlySet<number>>> = {}
  for (let i = 0; i < FIELDS.length; i++) {
    const field = FIELDS[i]
    const piece = parts[i]
    if (field === undefined || piece === undefined) return null
    const set = parseField(piece, field.min, field.max)
    if (set === null) return null
    out[field.name] = set
  }
  const base = out as Omit<ParsedCron, 'tz'>
  return tz !== undefined ? { ...base, tz } : { ...base }
}

function parseField(part: string, min: number, max: number): ReadonlySet<number> | null {
  const out = new Set<number>()
  for (const segment of part.split(',')) {
    const stepSplit = segment.split('/')
    const range = stepSplit[0]
    const step = stepSplit[1] !== undefined ? Number.parseInt(stepSplit[1], 10) : 1
    if (range === undefined) return null
    if (!Number.isFinite(step) || step < 1) return null

    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      const ai = a !== undefined ? Number.parseInt(a, 10) : Number.NaN
      const bi = b !== undefined ? Number.parseInt(b, 10) : Number.NaN
      if (!Number.isFinite(ai) || !Number.isFinite(bi)) return null
      lo = ai
      hi = bi
    } else {
      const n = Number.parseInt(range, 10)
      if (!Number.isFinite(n)) return null
      lo = n
      // single value with step doesn't really make sense in cron; treat as
      // "from N to max stepping by step" which matches Vixie-cron behavior.
      hi = stepSplit[1] !== undefined ? max : n
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
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

/**
 * Compute the next time the cron expression fires after `from`.
 * Walks forward minute by minute and returns the first match. Caps at
 * CRON_LOOKAHEAD_MS; returns null when no match falls within that window
 * (either an impossible expression like Feb 30, or a fire further out).
 */
export function nextFireTime(parsed: ParsedCron, from: Date): Date | null {
  // Start at the next whole minute; cron resolution is per-minute.
  const t = new Date(from.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)

  const cap = from.getTime() + CRON_LOOKAHEAD_MS

  while (t.getTime() <= cap) {
    const fields =
      parsed.tz !== undefined
        ? getFieldsInTz(t, parsed.tz)
        : {
            minute: t.getMinutes(),
            hour: t.getHours(),
            month: t.getMonth() + 1,
            dayOfMonth: t.getDate(),
            dayOfWeek: t.getDay(),
          }
    if (
      parsed.minute.has(fields.minute) &&
      parsed.hour.has(fields.hour) &&
      parsed.month.has(fields.month) &&
      parsed.dayOfMonth.has(fields.dayOfMonth) &&
      parsed.dayOfWeek.has(fields.dayOfWeek)
    ) {
      return t
    }
    t.setMinutes(t.getMinutes() + 1)
  }
  return null
}
