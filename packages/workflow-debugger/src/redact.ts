// Redaction is a security boundary: events and audit rows can carry secret
// values (a leaked token in an error message, a bearer header echoed by a
// failing HTTP tool). Nothing the debugger emits may reproduce a secret value.

const REDACTED = '[redacted]'

// Patterns matched case-insensitively against object KEYS. A value under any of
// these keys is dropped wholesale before it can reach the report.
const SECRET_KEY_RE =
  /(secret|token|password|passwd|apikey|api[_-]?key|authorization|auth[_-]?token|credential|private[_-]?key|access[_-]?key|client[_-]?secret|bearer|cookie|session[_-]?id)/i

// Patterns matched against string VALUES anywhere in the text. Each capturing
// group's secret span is replaced with the redaction marker; surrounding
// context (the key name, the scheme) is kept so the report is still legible.
const VALUE_PATTERNS: readonly RegExp[] = [
  // Authorization: Bearer <token>  /  "bearer <token>"
  /\b(bearer\s+)([A-Za-z0-9._\-+/=]{8,})/gi,
  // key=value / key: value where key looks secret-ish. `authorization` is
  // handled by the bearer pattern above so the scheme word stays legible.
  /\b((?:secret|token|password|api[_-]?key|apikey|credential|client[_-]?secret)\s*[=:]\s*)("?)([^\s"',}]{6,})\2/gi,
  // Common provider key prefixes (sk-..., ghp_..., xoxb-...).
  /\b((?:sk|ghp|gho|ghs|xoxb|xoxp|AKIA)[-_][A-Za-z0-9_\-]{8,})/g,
]

/** Redact secret-shaped substrings inside a single string. */
export function redactString(input: string): string {
  let out = input
  for (const re of VALUE_PATTERNS) {
    out = out.replace(re, (match, ...groups) => {
      // Patterns with a leading "context" group keep that group and redact the
      // rest; the bare-prefix pattern (no context group) redacts the whole
      // match.
      const named = groups.slice(0, -2)
      if (named.length >= 2 && typeof named[0] === 'string') {
        const prefix = named[0]
        const quote =
          typeof named[1] === 'string' && (named[1] === '"' || named[1] === "'") ? named[1] : ''
        return `${prefix}${quote}${REDACTED}${quote}`
      }
      return REDACTED
    })
  }
  return out
}

/**
 * Deep-redact an arbitrary serializable value: drops values under secret-shaped
 * keys, scrubs secret-shaped substrings from every remaining string, and bounds
 * recursion so a malicious/cyclic payload cannot run the redactor unbounded.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactValue(v, depth + 1)
  }
  return out
}

/** Redact then JSON-stringify a value into a bounded one-line detail string. */
export function redactToDetail(value: unknown, maxLen = 240): string {
  if (value === undefined) return ''
  const redacted = redactValue(value)
  let text: string
  if (typeof redacted === 'string') text = redacted
  else {
    try {
      text = JSON.stringify(redacted)
    } catch {
      text = String(redacted)
    }
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text
}
