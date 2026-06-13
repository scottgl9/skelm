/**
 * Shared request plumbing for the Google Sheets v4 REST API.
 *
 * SECURITY: the OAuth2 access token is supplied already resolved by the gateway
 * (this package never runs an OAuth dance and never reads `process.env`). The
 * token is used only to build a single `Authorization: Bearer` header for one
 * request and is never logged, stored, or returned. {@link redactBearer}
 * scrubs any accidental token-shaped string from diagnostics.
 */

import {
  type EgressPolicy,
  IntegrationRateLimitError,
  IntegrationSdkError,
  type RetryOptions,
  httpRequest,
  withRetry,
} from '@skelm/integration-sdk'

export const SHEETS_API_HOST = 'sheets.googleapis.com'
export const SHEETS_API_BASE = `https://${SHEETS_API_HOST}/v4/spreadsheets`

/** Inputs every action shares: target spreadsheet, resolved token, egress hook. */
export interface SheetsRequestContext {
  /** Google spreadsheet id (from the sheet URL). */
  readonly spreadsheetId: string
  /**
   * OAuth2 access token resolved by the gateway from a `CredentialReference`.
   * Used only to build the Bearer header; never logged or persisted.
   */
  readonly accessToken: string
  /** Gateway-supplied egress policy; the request is refused for denied hosts. */
  readonly egress: EgressPolicy
  /** Injected fetch for deterministic tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
  /** Retry overrides (injected sleep in tests). */
  readonly retry?: RetryOptions
  readonly signal?: AbortSignal
}

/** A token shaped like a Google OAuth access token, for redaction. */
const TOKEN_RE = /ya29\.[\w.\-]+|Bearer\s+[\w.\-]+/g

/**
 * Remove anything that looks like a bearer token or Google access token from a
 * string before it reaches logs, audit rows, or error messages.
 */
export function redactBearer(text: string): string {
  return text.replace(TOKEN_RE, '[REDACTED]')
}

/** True when an error/status should be retried (network blip or 429/5xx). */
export function isRetryableSheetsError(error: unknown): boolean {
  if (error instanceof IntegrationRateLimitError) return true
  if (error instanceof SheetsApiError) return error.status === 429 || error.status >= 500
  if (error instanceof IntegrationSdkError) return false
  return true
}

/** A classified Google Sheets API error. Carries no token or secret. */
export class SheetsApiError extends IntegrationSdkError {
  override readonly name: string = 'SheetsApiError'
  readonly status: number
  readonly googleStatus?: string

  constructor(message: string, status: number, googleStatus?: string) {
    super(redactBearer(message))
    this.status = status
    if (googleStatus !== undefined) this.googleStatus = googleStatus
  }
}

function buildHeaders(accessToken: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` }
  if (hasBody) headers['content-type'] = 'application/json'
  return headers
}

async function parseError(res: Response): Promise<SheetsApiError> {
  let detail = res.statusText
  let googleStatus: string | undefined
  try {
    const body = (await res.json()) as {
      error?: { message?: string; status?: string }
    }
    if (typeof body.error?.message === 'string') detail = body.error.message
    if (typeof body.error?.status === 'string') googleStatus = body.error.status
  } catch {
    // Non-JSON error body; keep statusText.
  }
  const message = `Google Sheets API ${res.status}: ${detail}`
  return new SheetsApiError(message, res.status, googleStatus)
}

/**
 * Execute one Sheets request with egress enforcement, bearer auth, retry on
 * 429/5xx, and typed error classification. Returns the parsed JSON body.
 */
export async function sheetsRequest<T>(
  ctx: SheetsRequestContext,
  path: string,
  init: {
    method?: string
    query?: Readonly<Record<string, string | undefined>>
    body?: unknown
  } = {},
): Promise<T> {
  const url = new URL(`${SHEETS_API_BASE}/${ctx.spreadsheetId}${path}`)
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, v)
  }
  const bodyStr = init.body === undefined ? undefined : JSON.stringify(init.body)

  return withRetry(
    async () => {
      const res = await httpRequest(url.toString(), {
        method: init.method ?? 'GET',
        headers: buildHeaders(ctx.accessToken, bodyStr !== undefined),
        ...(bodyStr !== undefined ? { body: bodyStr } : {}),
        egress: ctx.egress,
        ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      if (!res.ok) throw await parseError(res)
      return (await res.json()) as T
    },
    { isRetryable: isRetryableSheetsError, ...ctx.retry },
  )
}
