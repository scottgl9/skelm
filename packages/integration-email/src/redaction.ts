/**
 * Audit/log redaction for the email integration.
 *
 * Email is unusually sensitive: the password is a secret, and message bodies
 * (text/html) routinely carry PII or confidential content. The audit redaction
 * policy below names those paths so the gateway's single audit writer redacts
 * them. {@link redactMailFields} is the in-package helper actions use to scrub a
 * value before it goes anywhere observable (returned diagnostics, errors). It
 * never mutates its input.
 */

import type { AuditRedactionPolicy } from '@skelm/integration-sdk'

/** Field paths the gateway audit writer must redact for this integration. */
export const EMAIL_AUDIT_REDACTION: AuditRedactionPolicy = {
  redactPaths: [
    'credentials.password',
    'password',
    'message.text',
    'message.html',
    'message.attachments',
    'event.payload.text',
    'event.payload.html',
  ],
}

const REDACTED = '[redacted]'
/** Keys whose values are always scrubbed regardless of where they appear. */
const SENSITIVE_KEYS = new Set([
  'password',
  'secret',
  'token',
  'apiKey',
  'accessToken',
  'text',
  'html',
  'content',
])

/**
 * Return a deep copy of `value` with sensitive keys replaced by `[redacted]`.
 * Used to scrub anything that might be logged, returned as a diagnostic, or
 * embedded in an error. Pure — does not mutate `value`.
 */
export function redactMailFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactMailFields(v))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k) ? REDACTED : redactMailFields(v)
    }
    return out
  }
  return value
}
