/**
 * Gateway HTTP client surface the bridge depends on.
 *
 * The bridge NEVER reimplements the gateway: every privileged action (run,
 * start, status, cancel, audit, workflow search) is an HTTP call to the
 * gateway, which owns permission enforcement, secret resolution, and audit.
 *
 * SECURITY INVARIANTS:
 *  - The bearer token is supplied BY REFERENCE ({@link CredentialReference}),
 *    never as a value. The bridge resolves it through a caller-supplied
 *    {@link BearerResolver} (gateway/host-owned) at call time and never reads
 *    `process.env` itself.
 *  - The resolved token lives only inside the request `Authorization` header.
 *    It is never returned, logged, or placed in an error message. The client
 *    interface below intentionally exposes only `secretName` to callers.
 *
 * `GatewayHttpClient` is the seam tests inject a fake through — there is no
 * real network in unit tests.
 */

import type { CredentialReference } from '@skelm/integration-sdk'
import { GatewayAuthError, GatewayRequestError } from './errors.js'

/** A single gateway HTTP request, transport-agnostic. */
export interface GatewayRequest {
  readonly method: 'GET' | 'POST' | 'DELETE'
  /** Gateway-relative path (e.g. `/pipelines/foo/run`). */
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: unknown
}

/** A gateway HTTP response, normalized for the bridge. */
export interface GatewayResponse {
  readonly status: number
  readonly ok: boolean
  readonly body: unknown
}

/**
 * The transport seam. The default implementation issues real `fetch` calls;
 * tests inject a fake that records requests and returns canned responses. The
 * bridge talks ONLY through this interface, never `fetch` directly, so no test
 * touches a real gateway.
 */
export interface GatewayHttpClient {
  request(req: GatewayRequest): Promise<GatewayResponse>
}

/**
 * Resolves a bearer credential reference to an ephemeral token. Supplied by the
 * host/gateway layer that owns secret material; the bridge calls it per request
 * and discards the value immediately after attaching the header. Returning the
 * token from here is the only place a value exists in this package.
 */
export type BearerResolver = (ref: CredentialReference) => Promise<string> | string

export interface GatewayClientOptions {
  /** Gateway base URL, e.g. `http://127.0.0.1:14738`. */
  readonly baseUrl: string
  /** Reference to the gateway bearer token. Never a value. */
  readonly bearer?: CredentialReference
  /** Resolves {@link bearer} to an ephemeral token at request time. */
  readonly resolveBearer?: BearerResolver
  /** Injectable `fetch` for tests/sandboxes; defaults to global `fetch`. */
  readonly fetch?: typeof fetch
}

function buildUrl(baseUrl: string, req: GatewayRequest): string {
  const url = new URL(req.path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v)
  }
  return url.toString()
}

/**
 * Default `fetch`-backed {@link GatewayHttpClient}. Resolves the bearer
 * reference to a header value per request; the token never leaves this function
 * scope. A 401/403 surfaces as {@link GatewayAuthError} with no token in the
 * message.
 */
export function createGatewayClient(opts: GatewayClientOptions): GatewayHttpClient {
  const doFetch = opts.fetch ?? fetch
  return {
    async request(req: GatewayRequest): Promise<GatewayResponse> {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (opts.bearer) {
        if (!opts.resolveBearer) {
          throw new GatewayRequestError(
            `bearer credential ref "${opts.bearer.secretName}" given but no resolveBearer supplied`,
            0,
          )
        }
        const token = await opts.resolveBearer(opts.bearer)
        headers.Authorization = `Bearer ${token}`
      }
      const init: RequestInit = { method: req.method, headers }
      if (req.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(req.body)
      }
      const res = await doFetch(buildUrl(opts.baseUrl, req), init)
      const text = await res.text()
      const body: unknown = text === '' ? null : safeJson(text)
      if (res.status === 401 || res.status === 403) throw new GatewayAuthError(res.status)
      return { status: res.status, ok: res.ok, body }
    },
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
