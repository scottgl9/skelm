/**
 * Typed ActionDefinitions and runtime implementations for the HTTP integration.
 *
 * All actions require a caller-supplied EgressPolicy; egress is enforced by
 * that policy hook — an action cannot proceed if the policy denies the host.
 * Credentials are never resolved here; the caller assembles resolved header
 * strings (from gateway-resolved CredentialReferences) and passes them in.
 * Authorization header values are redacted from any logged/audited output.
 */

import {
  type ActionDefinition,
  type EgressPolicy,
  type Page,
  type RateLimiter,
  type RetryOptions,
  httpRequest,
  paginate,
  withRetry,
} from '@skelm/integration-sdk'
import { HttpClientError, HttpNetworkError, HttpServerError } from './errors.js'
import { redactHeaders, redactUrl } from './redact.js'

// ---------------------------------------------------------------------------
// Shared option types
// ---------------------------------------------------------------------------

export interface HttpActionOptions {
  /** Resolved header strings (e.g. `Authorization: Bearer <resolved-value>`). */
  readonly headers?: Readonly<Record<string, string>>
  /** Query string parameters appended to the URL. */
  readonly query?: Readonly<Record<string, string>>
  /** Optional retry configuration. */
  readonly retry?: RetryOptions
  /** Optional rate limiter; {@link RateLimiter.tryAcquire} is called before every attempt. */
  readonly rateLimiter?: RateLimiter
  /** Required egress policy; host must be allowed before the request is sent. */
  readonly egress: EgressPolicy
  /** Injected fetch for tests. */
  readonly fetchImpl?: typeof fetch
  /** AbortSignal forwarded to fetch. */
  readonly signal?: AbortSignal
}

export interface RequestInput extends HttpActionOptions {
  readonly method: string
  readonly url: string
  readonly body?: string
}

export interface RequestOutput {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

// ---------------------------------------------------------------------------
// ActionDefinitions (metadata consumed by the gateway manifest)
// ---------------------------------------------------------------------------

export const requestActionDef: ActionDefinition = {
  id: 'http.request',
  description: 'Perform an authenticated HTTP request with egress enforcement.',
  requiredPermissions: ['egress'],
}

export const getActionDef: ActionDefinition = {
  id: 'http.get',
  description: 'Convenience GET request.',
  requiredPermissions: ['egress'],
}

export const postActionDef: ActionDefinition = {
  id: 'http.post',
  description: 'Convenience POST request with a JSON body.',
  requiredPermissions: ['egress'],
}

export const paginateActionDef: ActionDefinition = {
  id: 'http.paginate',
  description: 'Cursor-paginated GET requests collected into a flat array.',
  requiredPermissions: ['egress'],
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

function buildUrl(base: string, query?: Readonly<Record<string, string>>): string {
  if (!query || Object.keys(query).length === 0) return base
  const u = new URL(base)
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
  return u.toString()
}

// ---------------------------------------------------------------------------
// Response classifier
// ---------------------------------------------------------------------------

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    try {
      return (await res.json()) as unknown
    } catch {
      return await res.text()
    }
  }
  return await res.text()
}

function collectHeaders(res: Response): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    out[k] = v
  })
  return out
}

// ---------------------------------------------------------------------------
// Core request implementation
// ---------------------------------------------------------------------------

async function executeRequest(input: RequestInput): Promise<RequestOutput> {
  const url = buildUrl(input.url, input.query)

  const doOnce = async (): Promise<RequestOutput> => {
    if (input.rateLimiter && !input.rateLimiter.tryAcquire()) {
      const wait = input.rateLimiter.waitTimeMs()
      throw new HttpClientError(`Rate limit exceeded; retry after ${wait}ms`, 429)
    }

    let res: Response
    try {
      res = await httpRequest(url, {
        method: input.method,
        ...(input.headers !== undefined ? { headers: input.headers } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        egress: input.egress,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      })
    } catch (err) {
      // httpRequest throws IntegrationSdkError for egress deny / bad URL — let
      // those propagate unwrapped. Network-level TypeError gets wrapped.
      if (err instanceof TypeError) {
        throw new HttpNetworkError(
          `Network error fetching ${redactUrl(url)}: ${(err as Error).message}`,
          err as unknown,
        )
      }
      throw err
    }

    const status = res.status
    const headers = collectHeaders(res)
    const body = await parseBody(res)

    if (status >= 400 && status < 500) {
      throw new HttpClientError(`HTTP ${status} from ${redactUrl(url)}`, status)
    }
    if (status >= 500) {
      throw new HttpServerError(`HTTP ${status} from ${redactUrl(url)}`, status)
    }

    return { status, headers, body }
  }

  const retryOpts: RetryOptions = {
    ...(input.retry ?? {}),
    isRetryable: (err: unknown) => {
      if (err instanceof HttpServerError && isRetryableStatus(err.statusCode)) return true
      if (err instanceof HttpNetworkError) return true
      return false
    },
  }

  return withRetry(doOnce, retryOpts)
}

// ---------------------------------------------------------------------------
// Public action functions
// ---------------------------------------------------------------------------

/**
 * Perform an HTTP request of any method. Credential values must already be
 * resolved by the gateway and supplied as concrete header strings; they are
 * never logged (see {@link redactHeaders}).
 */
export async function request(input: RequestInput): Promise<RequestOutput> {
  return executeRequest(input)
}

/** Convenience GET. */
export async function get(url: string, opts: HttpActionOptions): Promise<RequestOutput> {
  return executeRequest({ ...opts, method: 'GET', url })
}

/** Convenience POST with a JSON body. */
export async function post(
  url: string,
  body: unknown,
  opts: HttpActionOptions,
): Promise<RequestOutput> {
  return executeRequest({
    ...opts,
    method: 'POST',
    url,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  })
}

// ---------------------------------------------------------------------------
// Pagination action
// ---------------------------------------------------------------------------

export interface PaginateInput extends HttpActionOptions {
  readonly url: string
  /** Extract the next cursor from a parsed response body. Return undefined to stop. */
  readonly getNextCursor: (body: unknown) => string | undefined
  /** Extract items from a parsed response body. */
  readonly getItems: (body: unknown) => unknown[]
  /** Maximum pages to fetch. */
  readonly maxPages?: number
}

/**
 * Drive cursor-based HTTP pagination to exhaustion, collecting all items into
 * an array. The caller supplies `getNextCursor` and `getItems` to adapt any
 * response shape.
 */
export async function paginateAll(input: PaginateInput): Promise<unknown[]> {
  const items: unknown[] = []

  const fetchPage = async (cursor: string | undefined): Promise<Page<unknown>> => {
    const query: Record<string, string> = { ...(input.query ?? {}) }
    if (cursor !== undefined) query.cursor = cursor

    const result = await executeRequest({
      ...input,
      method: 'GET',
      url: input.url,
      query,
    })

    const pageItems = input.getItems(result.body)
    const nextCursor = input.getNextCursor(result.body)
    return nextCursor !== undefined ? { items: pageItems, nextCursor } : { items: pageItems }
  }

  const paginateOpts = input.maxPages !== undefined ? { maxPages: input.maxPages } : {}
  for await (const item of paginate(fetchPage, paginateOpts)) {
    items.push(item)
  }

  return items
}

// ---------------------------------------------------------------------------
// Audit-safe log descriptor
// ---------------------------------------------------------------------------

/**
 * Build a safe log descriptor for a request: method + host + status only.
 * Never includes Authorization or other credential headers.
 */
export function auditDescriptor(
  method: string,
  url: string,
  status: number,
  headers?: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> {
  let host = '<unknown>'
  try {
    host = new URL(url).host
  } catch {
    // invalid url — host stays unknown
  }
  return {
    method: method.toUpperCase(),
    host,
    status,
    headers: redactHeaders(headers ?? {}),
  }
}
