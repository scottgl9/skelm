/**
 * Error classification for mail operations.
 *
 * Maps an unknown thrown value to a coarse class the gateway uses for retry and
 * health decisions, plus a short non-secret reason. The reason is derived only
 * from the error name/code/message; a password can never reach it because the
 * resolved password is never embedded in an error message by this package.
 */

import { EmailAuthError, EmailTransientError } from './errors.js'

export type ErrorClass = 'auth' | 'transient' | 'message' | 'unknown'

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ESOCKET',
  'ETLS',
])

/** Coarse class + a short non-secret reason for an unknown error. */
export function classifyError(error: unknown): { class: ErrorClass; reason: string } {
  if (error instanceof EmailAuthError) return { class: 'auth', reason: 'authentication failed' }
  if (error instanceof EmailTransientError)
    return { class: 'transient', reason: 'transient connection error' }

  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') {
    if (TRANSIENT_CODES.has(code)) return { class: 'transient', reason: code }
    if (code === 'EAUTH' || code === 'AUTHENTICATIONFAILED')
      return { class: 'auth', reason: 'authentication failed' }
  }

  const responseCode = (error as { responseCode?: unknown } | null)?.responseCode
  if (typeof responseCode === 'number') {
    if (responseCode === 535 || responseCode === 530)
      return { class: 'auth', reason: 'authentication rejected by server' }
    if (responseCode >= 400 && responseCode < 500)
      return { class: 'transient', reason: `server returned ${responseCode}` }
  }

  return { class: 'unknown', reason: 'unexpected error' }
}

/** True when an error is safe to retry (transient). */
export function isRetryableMailError(error: unknown): boolean {
  return classifyError(error).class === 'transient'
}
