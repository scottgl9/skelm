/**
 * Egress-gated Jira Cloud REST v3 client.
 *
 * SECURITY: this client never reads `process.env` and never holds a credential
 * reference — the gateway resolves {@link CredentialReference}s to ephemeral
 * values and hands them in as {@link JiraResolvedCredentials}. The assembled
 * `Authorization` header is built per-request and is never logged. Every call
 * goes through the SDK `httpRequest`, which refuses any host the supplied
 * {@link EgressPolicy} denies, so the integration can never bypass network
 * policy.
 */

import {
  type EgressPolicy,
  RateLimiter,
  type RetryOptions,
  httpRequest,
  withRetry,
} from '@skelm/integration-sdk'
import { JiraApiError, isRetryableJiraError } from './errors.js'

/**
 * Credential values resolved by the gateway from the connection's
 * {@link CredentialReference}s. Passed in per dispatch; never persisted, never
 * logged.
 */
export interface JiraResolvedCredentials {
  /** Atlassian account email used as the Basic-auth username. */
  readonly email: string
  /** Atlassian API token used as the Basic-auth password. */
  readonly apiToken: string
}

export interface JiraClientOptions {
  /** Site base URL, e.g. `https://your-domain.atlassian.net`. */
  readonly baseUrl: string
  readonly credentials: JiraResolvedCredentials
  /** Required egress hook supplied by the gateway. */
  readonly egress: EgressPolicy
  /** Injected fetch for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
  /** Per-request timeout in ms; default 30s. */
  readonly timeoutMs?: number
  /** Retry policy for transient failures. */
  readonly retry?: RetryOptions
  /** Client-side rate limiter (requests per window). Optional. */
  readonly rateLimit?: { readonly requests: number; readonly windowMs: number }
}

const DEFAULT_TIMEOUT_MS = 30_000
const API_V3 = '/rest/api/3'

interface JiraRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path relative to `/rest/api/3` (e.g. `/issue`). */
  readonly path: string
  readonly body?: unknown
  readonly query?: Readonly<Record<string, string | number | undefined>>
}

/**
 * Build the `Authorization: Basic` header value from resolved credentials.
 * Exported so callers (and tests) can assert the token is present on the wire
 * yet absent from any logged/audited surface.
 */
export function basicAuthHeader(creds: JiraResolvedCredentials): string {
  const encoded = Buffer.from(`${creds.email}:${creds.apiToken}`, 'utf8').toString('base64')
  return `Basic ${encoded}`
}

/** A thin typed wrapper over the Jira Cloud REST v3 surface. */
export class JiraClient {
  private readonly limiter?: RateLimiter

  constructor(private readonly opts: JiraClientOptions) {
    if (opts.rateLimit) {
      this.limiter = new RateLimiter(opts.rateLimit.requests, opts.rateLimit.windowMs)
    }
  }

  get baseUrl(): string {
    return this.opts.baseUrl.replace(/\/+$/, '')
  }

  /** Make a JSON Jira REST call with egress gating, retry, and rate limiting. */
  async request<T = unknown>(req: JiraRequest): Promise<T> {
    return withRetry(() => this.doRequest<T>(req), {
      isRetryable: isRetryableJiraError,
      ...this.opts.retry,
    })
  }

  private async doRequest<T>(req: JiraRequest): Promise<T> {
    if (this.limiter && !this.limiter.tryAcquire()) {
      const waitMs = this.limiter.waitTimeMs()
      throw new JiraApiError(429, req.method, req.path, 'client-side rate limit', waitMs / 1000)
    }
    const url = `${this.baseUrl}${API_V3}${req.path}${formatQuery(req.query)}`
    const headers: Record<string, string> = {
      Authorization: basicAuthHeader(this.opts.credentials),
      Accept: 'application/json',
    }
    if (req.body !== undefined) headers['Content-Type'] = 'application/json'

    const res = await httpRequest(url, {
      method: req.method,
      headers,
      egress: this.opts.egress,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    })

    const text = await res.text()
    const parsed = text.length > 0 ? safeJsonParse(text) : undefined
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'))
      throw new JiraApiError(
        res.status,
        req.method,
        req.path,
        parsed ?? text,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      )
    }
    return parsed as T
  }
}

function formatQuery(query: JiraRequest['query']): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const s = params.toString()
  return s.length > 0 ? `?${s}` : ''
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
