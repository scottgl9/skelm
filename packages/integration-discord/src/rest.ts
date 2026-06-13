/**
 * Minimal fetch-based Discord REST client.
 *
 * Deliberately NOT discord.js: the default conversation path needs only a
 * handful of REST endpoints, and the SDK already supplies the egress gate,
 * retry, and rate-limit primitives. A heavy gateway-websocket SDK would pull in
 * a large dependency surface for no benefit on the REST send/edit/react path.
 *
 * SECURITY: this client never resolves a credential reference and never reads
 * `process.env`. The bot token arrives as a resolved string the gateway handed
 * the adapter at dispatch; the client holds it only for the lifetime of the
 * connected adapter and never logs it. Every request runs through
 * {@link httpRequest}, so the gateway-supplied {@link EgressPolicy} can refuse
 * any host.
 */

import { type EgressPolicy, httpRequest, withRetry } from '@skelm/integration-sdk'
import { DiscordApiError } from './errors.js'
import { DISCORD_API_BASE } from './types.js'

export interface DiscordRestClientOptions {
  /** Resolved bot token (gateway-supplied). Used only as an Authorization header value. */
  readonly botToken: string
  /** Required egress hook; the request is refused unless the host is allowed. */
  readonly egress: EgressPolicy
  /** Injected fetch for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
  /** Total attempts including the first, for retryable failures. Defaults to 3. */
  readonly maxAttempts?: number
}

/**
 * Decide whether a Discord REST failure is worth retrying. 429 (rate limit) and
 * 5xx are transient; 4xx (other than 429) are client errors that will not
 * succeed on retry.
 */
export function isRetryableDiscordError(error: unknown): boolean {
  if (error instanceof DiscordApiError) {
    return error.status === 429 || error.status >= 500
  }
  // Network/transport errors (no HTTP status) are retryable.
  return true
}

export class DiscordRestClient {
  private readonly botToken: string
  private readonly egress: EgressPolicy
  private readonly fetchImpl: typeof fetch
  private readonly maxAttempts: number

  constructor(opts: DiscordRestClientOptions) {
    this.botToken = opts.botToken
    this.egress = opts.egress
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.maxAttempts = opts.maxAttempts ?? 3
  }

  async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${DISCORD_API_BASE}${path}`
    return withRetry(
      async () => {
        const res = await httpRequest(url, {
          method,
          egress: this.egress,
          fetchImpl: this.fetchImpl,
          headers: {
            authorization: `Bot ${this.botToken}`,
            'content-type': 'application/json',
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          ...(signal !== undefined ? { signal } : {}),
        })
        if (!res.ok) {
          const detail = await safeErrorDetail(res)
          throw new DiscordApiError(
            `Discord API ${method} ${path} failed: HTTP ${res.status}${detail}`,
            res.status,
          )
        }
        if (res.status === 204) return undefined as T
        return (await res.json()) as T
      },
      { maxAttempts: this.maxAttempts, isRetryable: isRetryableDiscordError },
    )
  }
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { message?: unknown; code?: unknown }
    const message = typeof json.message === 'string' ? json.message : undefined
    const code = typeof json.code === 'number' ? json.code : undefined
    if (message === undefined && code === undefined) return ''
    return ` (${[code !== undefined ? `code ${code}` : '', message ?? ''].filter(Boolean).join(': ')})`
  } catch {
    return ''
  }
}
