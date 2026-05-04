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
 */

export interface ParsedCron {
  minute: ReadonlySet<number>
  hour: ReadonlySet<number>
  dayOfMonth: ReadonlySet<number>
  month: ReadonlySet<number>
  dayOfWeek: ReadonlySet<number>
}

const FIELDS: Array<{ name: keyof ParsedCron; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
]

export function parseCron(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const out: Partial<Record<keyof ParsedCron, ReadonlySet<number>>> = {}
  for (let i = 0; i < FIELDS.length; i++) {
    const field = FIELDS[i]
    const piece = parts[i]
    if (field === undefined || piece === undefined) return null
    const set = parseField(piece, field.min, field.max)
    if (set === null) return null
    out[field.name] = set
  }
  return out as ParsedCron
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
 * Compute the next time the cron expression fires after `from`.
 * Walks forward minute by minute and returns the first match. Caps at
 * 366 days lookahead — a cron that never fires (e.g., Feb 30) returns null.
 */
export function nextFireTime(parsed: ParsedCron, from: Date): Date | null {
  // Start at the next whole minute; cron resolution is per-minute.
  const t = new Date(from.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)

  const horizonMs = 366 * 24 * 60 * 60 * 1000
  const cap = from.getTime() + horizonMs

  while (t.getTime() <= cap) {
    if (
      parsed.minute.has(t.getMinutes()) &&
      parsed.hour.has(t.getHours()) &&
      parsed.month.has(t.getMonth() + 1) &&
      parsed.dayOfMonth.has(t.getDate()) &&
      parsed.dayOfWeek.has(t.getDay())
    ) {
      return t
    }
    t.setMinutes(t.getMinutes() + 1)
  }
  return null
}
