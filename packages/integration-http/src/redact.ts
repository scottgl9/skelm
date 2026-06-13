/**
 * Redaction helpers.
 *
 * Authorization header values and any credential-bearing headers must never
 * appear in logs, audit rows, or error messages. These helpers strip them
 * before any value reaches an observable surface.
 */

/** Header names whose values are always redacted. Case-insensitive match. */
const REDACTED_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
  'cookie',
  'set-cookie',
])

const REDACTED_SENTINEL = '[REDACTED]'

/**
 * Return a copy of `headers` with sensitive header values replaced by
 * `[REDACTED]`. Safe to include in logs, audit rows, and error messages.
 */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? REDACTED_SENTINEL : v
  }
  return out
}

/**
 * Strip any `Authorization` / credential query params from a URL before
 * including it in a log or error message. Returns only scheme+host+path.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return '<invalid-url>'
  }
}
