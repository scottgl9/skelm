/**
 * Deterministic test/self-test helpers: a fake {@link GatewayHttpClient} that
 * records requests and returns canned responses keyed by `METHOD path`. No real
 * gateway, no real network — the same seam production uses, with a scripted
 * transport. The fake also records `Authorization` only as a boolean presence
 * flag, never the value, so tests can assert the token was never captured.
 */

import type { GatewayHttpClient, GatewayRequest, GatewayResponse } from './client.js'

export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: unknown
}

export type CannedResponse = Partial<GatewayResponse> & { readonly body?: unknown }

/** A fake gateway client driven by a route → response map. */
export class FakeGatewayClient implements GatewayHttpClient {
  readonly requests: RecordedRequest[] = []
  private readonly routes: Map<string, CannedResponse>

  constructor(routes: Record<string, CannedResponse> = {}) {
    this.routes = new Map(Object.entries(routes))
  }

  /** Register or override a canned response for `METHOD /path`. */
  on(method: string, path: string, res: CannedResponse): this {
    this.routes.set(`${method} ${path}`, res)
    return this
  }

  async request(req: GatewayRequest): Promise<GatewayResponse> {
    this.requests.push({
      method: req.method,
      path: req.path,
      ...(req.query ? { query: req.query } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
    })
    const canned = this.routes.get(`${req.method} ${req.path}`)
    if (!canned) {
      return {
        status: 404,
        ok: false,
        body: { error: `no fake route for ${req.method} ${req.path}` },
      }
    }
    const status = canned.status ?? 200
    return { status, ok: canned.ok ?? (status >= 200 && status < 300), body: canned.body ?? null }
  }
}
