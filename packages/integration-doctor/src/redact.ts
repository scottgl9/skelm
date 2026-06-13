/**
 * Redaction for doctor reports.
 *
 * SECURITY INVARIANT: a doctor report is shown to operators and may be logged.
 * It must never carry a secret value. Probes are supplied by the gateway and
 * are contractually non-secret in their `detail`, but the doctor defends in
 * depth: every string that reaches a report is scrubbed here so a leaked token
 * in a probe's detail string cannot escape.
 */

export const REDACTED = '[redacted]'

/**
 * Patterns for credential-shaped substrings. Conservative: matches long
 * high-entropy tokens and common provider key prefixes, plus explicit
 * `secret`/`token`/`password`/`apiKey` assignments.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // key=value or "key": "value" for sensitive field names
  /\b(secret|token|password|apikey|api[_-]?key|access[_-]?token|bearer)\b\s*[:=]\s*["']?[^\s"',}]+/gi,
  // Authorization: Bearer <token>
  /\bbearer\s+[A-Za-z0-9._\-]{8,}/gi,
  // Common provider token prefixes followed by a long body.
  /\b(?:xox[abprs]-|ghp_|gho_|ghs_|sk-|pk-|AKIA)[A-Za-z0-9-]{8,}/g,
  // Bare high-entropy blobs (>= 24 chars of token-alphabet).
  /\b[A-Za-z0-9_\-]{24,}\b/g,
]

/**
 * Redact secret-shaped substrings from `text`. Returns a copy with any match
 * replaced by {@link REDACTED}. Idempotent and safe on `undefined`.
 */
export function redact(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED)
  }
  return out
}
