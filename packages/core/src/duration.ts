const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/i

const DURATION_MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/**
 * Parse a duration string like `"15m"`, `"500ms"`, `"2h"`, `"1d"` into
 * milliseconds. Throws on unparseable input — callers pass user-authored
 * strings, so a clear error beats a silent fallback.
 */
export function parseDuration(value: string): number {
  const trimmed = value.trim()
  const match = DURATION_RE.exec(trimmed)
  if (match === null) {
    throw new Error(`invalid duration "${value}": expected <number><unit> using ms, s, m, h, or d`)
  }
  const amount = Number.parseInt(match[1] ?? '', 10)
  const unit = (match[2] ?? '').toLowerCase()
  const multiplier = DURATION_MULTIPLIERS[unit]
  if (multiplier === undefined) {
    throw new Error(`invalid duration "${value}": expected <number><unit> using ms, s, m, h, or d`)
  }
  return amount * multiplier
}
