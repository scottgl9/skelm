import { IntegrationSdkError } from '@skelm/integration-sdk'

/**
 * Error raised when a Jira REST call returns a non-2xx status. `body` is the
 * parsed JSON error payload when present, otherwise the raw text. The
 * constructor never embeds credential values — only method, path, and status.
 */
export class JiraApiError extends IntegrationSdkError {
  override readonly name: string = 'JiraApiError'
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
    /** Seconds the provider asked us to wait, parsed from `Retry-After`. */
    readonly retryAfterSeconds?: number,
  ) {
    super(`Jira ${method} ${path} failed with ${status}: ${formatBody(body)}`)
  }

  /** 429 and 5xx are transient; 4xx (except 429) are caller errors. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}

function formatBody(body: unknown): string {
  if (typeof body === 'string') return body
  if (body && typeof body === 'object') {
    const b = body as { errorMessages?: unknown; errors?: unknown; message?: unknown }
    if (Array.isArray(b.errorMessages) && b.errorMessages.length > 0) {
      return b.errorMessages.join('; ')
    }
    if (b.errors && typeof b.errors === 'object') {
      const parts = Object.entries(b.errors as Record<string, unknown>).map(
        ([k, v]) => `${k}: ${String(v)}`,
      )
      if (parts.length > 0) return parts.join('; ')
    }
    if (typeof b.message === 'string') return b.message
  }
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

/**
 * Classify an arbitrary thrown value for retry. Network/abort errors and
 * transient {@link JiraApiError}s (429, 5xx) are retryable; everything else is
 * not. Used as the `isRetryable` predicate for `withRetry`.
 */
export function isRetryableJiraError(error: unknown): boolean {
  if (error instanceof JiraApiError) return error.retryable
  if (error instanceof IntegrationSdkError) return false
  return error instanceof Error
}
