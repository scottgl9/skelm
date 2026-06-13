/**
 * Provider health check — a HEAD (falling back to GET) against a configured
 * base URL, routed through the egress policy.
 */

import { type EgressPolicy, type ProviderHealthCheck, httpRequest } from '@skelm/integration-sdk'

export interface HttpHealthCheckOptions {
  /** Base URL to probe (scheme+host, e.g. `https://api.example.com`). */
  readonly baseUrl: string
  /** Required egress policy; host must be allowed before the probe is sent. */
  readonly egress: EgressPolicy
  /** Override probe method; defaults to HEAD. */
  readonly method?: 'HEAD' | 'GET'
  /** Injected fetch for tests. */
  readonly fetchImpl?: typeof fetch
  /** Timeout signal forwarded to fetch. */
  readonly signal?: AbortSignal
}

/**
 * Perform a liveness probe against `baseUrl`. Returns a {@link ProviderHealthCheck}
 * with no secret values in `detail`. A 2xx or 3xx response is healthy; 4xx/5xx
 * and network errors are unhealthy.
 */
export async function checkHealth(opts: HttpHealthCheckOptions): Promise<ProviderHealthCheck> {
  const checkedAt = new Date().toISOString()
  let host: string
  try {
    host = new URL(opts.baseUrl).hostname
  } catch {
    return {
      healthy: false,
      status: 'error',
      checkedAt,
      detail: 'Invalid baseUrl for health check',
    }
  }

  try {
    const res = await httpRequest(opts.baseUrl, {
      method: opts.method ?? 'HEAD',
      egress: opts.egress,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    const healthy = res.status < 400
    return {
      healthy,
      status: healthy ? 'ok' : 'unhealthy',
      checkedAt,
      detail: `${opts.method ?? 'HEAD'} ${host} → ${res.status}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Strip any URL that might contain query-param credentials.
    const safe = msg.replace(/https?:\/\/[^\s"']*/g, `${new URL(opts.baseUrl).protocol}//${host}`)
    return {
      healthy: false,
      status: 'error',
      checkedAt,
      detail: safe,
    }
  }
}
