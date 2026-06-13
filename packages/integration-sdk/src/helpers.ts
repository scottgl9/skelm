/**
 * Universal action/trigger helpers reusable by every integration package.
 *
 * These are real, tested primitives — signature verification, an egress-gated
 * HTTP helper, a webhook normalizer, pagination, retry/backoff, a rate limiter,
 * idempotency, and a normalized event envelope. Privileged egress stays the
 * gateway's responsibility: {@link httpRequest} takes an `egress` policy hook
 * the caller must supply, and resolves credentials only from
 * {@link CredentialReference}s the caller has already had the gateway resolve.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { IntegrationSdkError } from './errors.js'

// ---------------------------------------------------------------------------
// Signature / HMAC verification
// ---------------------------------------------------------------------------

/** Hash algorithms supported by {@link verifyHmacSignature}. */
export type HmacAlgorithm = 'sha1' | 'sha256' | 'sha512'

export interface VerifyHmacOptions {
  /** Raw request body bytes, exactly as received (do not re-serialize). */
  readonly payload: string
  /** The signature the provider sent. */
  readonly signature: string
  /** The shared signing secret (resolved by the gateway). */
  readonly secret: string
  readonly algorithm?: HmacAlgorithm
  /** Optional prefix the provider prepends to the hex digest (e.g. `sha256=`). */
  readonly prefix?: string
  /** Output encoding of the digest the provider sends. Defaults to `hex`. */
  readonly encoding?: 'hex' | 'base64'
}

/**
 * Constant-time HMAC signature verification. Generalizes the Slack-specific
 * `verifySlackSignature` approach (HMAC + `timingSafeEqual`) to arbitrary
 * algorithm/prefix/encoding without weakening it: the comparison is always
 * constant-time and length-guarded. Returns false on any mismatch.
 */
export function verifyHmacSignature(opts: VerifyHmacOptions): boolean {
  const algorithm = opts.algorithm ?? 'sha256'
  const encoding = opts.encoding ?? 'hex'
  const digest = createHmac(algorithm, opts.secret).update(opts.payload).digest(encoding)
  const expected = `${opts.prefix ?? ''}${digest}`
  const left = Buffer.from(opts.signature, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

// ---------------------------------------------------------------------------
// Normalized event envelope + webhook normalization
// ---------------------------------------------------------------------------

/**
 * Normalized envelope wrapping any inbound integration event before it becomes
 * a `RunInput`. Gives every trigger a consistent shape for dedupe, audit, and
 * routing regardless of provider.
 */
export interface EventEnvelope<TPayload = unknown> {
  /** Source integration/provider id (e.g. `github`). */
  readonly source: string
  /** Provider event type (e.g. `issues.opened`). */
  readonly type: string
  /** Stable provider event id, used for idempotency/dedupe. */
  readonly id: string
  /** Epoch milliseconds the event was received/normalized. */
  readonly receivedAt: number
  /** Normalized provider payload. */
  readonly payload: TPayload
  /** Non-secret correlation/metadata. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

/** Inputs to {@link normalizeWebhook}. */
export interface WebhookInput {
  readonly source: string
  /** Provider event type, often from a header or body field. */
  readonly type: string
  /** Stable provider event id; falls back to a content hash when absent. */
  readonly id?: string
  readonly payload: unknown
  readonly receivedAt?: number
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

/**
 * Normalize a verified webhook into an {@link EventEnvelope}. Signature
 * verification is the caller's responsibility and must happen before calling
 * this. When the provider supplies no event id, a stable id is derived from the
 * payload so idempotency still works.
 */
export function normalizeWebhook<TPayload = unknown>(input: WebhookInput): EventEnvelope<TPayload> {
  const id = input.id ?? deriveEventId(input.source, input.type, input.payload)
  return {
    source: input.source,
    type: input.type,
    id,
    receivedAt: input.receivedAt ?? Date.now(),
    payload: input.payload as TPayload,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
}

function deriveEventId(source: string, type: string, payload: unknown): string {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null)
  return createHmac('sha256', 'skelm-event-id').update(`${source}:${type}:${body}`).digest('hex')
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * In-memory idempotency tracker. Integration packages call {@link seen} to
 * suppress duplicate event ids within a TTL window. Bounded by `maxEntries`;
 * oldest entries are evicted first. Durable cross-process idempotency is the
 * gateway's job — this is a per-process guard.
 */
export class IdempotencyTracker {
  private readonly entries = new Map<string, number>()

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly maxEntries = 10_000,
  ) {}

  /** Record `id`; returns true if it was already seen within the TTL. */
  seen(id: string, now = Date.now()): boolean {
    this.evict(now)
    const existing = this.entries.get(id)
    if (existing !== undefined && existing > now) return true
    this.entries.set(id, now + this.ttlMs)
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    return false
  }

  private evict(now: number): void {
    for (const [id, expiry] of this.entries) {
      if (expiry <= now) this.entries.delete(id)
    }
  }
}

// ---------------------------------------------------------------------------
// Retry / backoff
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Total attempts including the first. Defaults to 3. */
  readonly maxAttempts?: number
  /** Base delay in ms for exponential backoff. Defaults to 200. */
  readonly baseDelayMs?: number
  /** Cap on a single delay in ms. Defaults to 30_000. */
  readonly maxDelayMs?: number
  /** Decide whether an error is retryable. Defaults to always retry. */
  readonly isRetryable?: (error: unknown) => boolean
  /** Sleep function; injected for tests. Defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Jitter factor in [0,1]; multiplies a random portion of the delay. Defaults to 0 (deterministic). */
  readonly jitter?: number
  /** Random source in [0,1); injected for tests. Defaults to Math.random. */
  readonly random?: () => number
}

/** Compute the exponential-backoff delay for a zero-based attempt index. */
export function backoffDelay(attempt: number, opts: RetryOptions = {}): number {
  const base = opts.baseDelayMs ?? 200
  const max = opts.maxDelayMs ?? 30_000
  const raw = Math.min(max, base * 2 ** attempt)
  const jitter = opts.jitter ?? 0
  if (jitter <= 0) return raw
  const rand = (opts.random ?? Math.random)()
  return Math.round(raw * (1 - jitter) + raw * jitter * rand)
}

/**
 * Run `fn` with exponential backoff. Retries only when `isRetryable` returns
 * true (defaults to always). Rethrows the last error after `maxAttempts`.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3
  const isRetryable = opts.isRetryable ?? (() => true)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts - 1 || !isRetryable(error)) break
      await sleep(backoffDelay(attempt, opts))
    }
  }
  throw lastError
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Sliding-window rate limiter. {@link tryAcquire} returns true when a slot is
 * available; {@link waitTimeMs} reports how long until the next slot frees.
 * Reuses the windowed approach in `IntegrationBase` as a standalone, testable
 * primitive.
 */
export class RateLimiter {
  private readonly timestamps: number[] = []

  constructor(
    private readonly requests: number,
    private readonly windowMs: number,
  ) {}

  tryAcquire(now = Date.now()): boolean {
    this.prune(now)
    if (this.timestamps.length >= this.requests) return false
    this.timestamps.push(now)
    return true
  }

  waitTimeMs(now = Date.now()): number {
    this.prune(now)
    if (this.timestamps.length < this.requests) return 0
    const oldest = this.timestamps[0]
    if (oldest === undefined) return 0
    return Math.max(0, oldest + this.windowMs - now)
  }

  private prune(now: number): void {
    const windowStart = now - this.windowMs
    while (this.timestamps.length > 0 && (this.timestamps[0] as number) <= windowStart) {
      this.timestamps.shift()
    }
  }
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** One page returned by a provider: items plus an optional next cursor. */
export interface Page<TItem> {
  readonly items: readonly TItem[]
  /** Cursor/token for the next page; absent/undefined ends pagination. */
  readonly nextCursor?: string
}

/**
 * Drive cursor-based pagination to exhaustion (or `maxPages`), yielding items.
 * `fetchPage` receives the current cursor (undefined on the first call).
 */
export async function* paginate<TItem>(
  fetchPage: (cursor: string | undefined) => Promise<Page<TItem>>,
  opts: { readonly maxPages?: number } = {},
): AsyncGenerator<TItem, void, void> {
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await fetchPage(cursor)
    for (const item of page.items) yield item
    cursor = page.nextCursor
    pages++
  } while (cursor !== undefined && pages < maxPages)
}

// ---------------------------------------------------------------------------
// HTTP request helper (egress-gated, credential-ref aware)
// ---------------------------------------------------------------------------

/**
 * Egress policy hook. The gateway supplies this; it decides whether a host may
 * be reached. The helper refuses the request when it returns `allow: false`,
 * so an integration package can never bypass network policy.
 */
export type EgressPolicy = (host: string) => { allow: boolean; reason?: string }

export interface HttpRequestOptions {
  readonly method?: string
  /** Header values are resolved strings only — never credential refs/values placed by the SDK. */
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
  /** Required egress hook; the host must be allowed before the request runs. */
  readonly egress: EgressPolicy
  /** Injected fetch for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
  readonly signal?: AbortSignal
}

/**
 * Perform an HTTP request after consulting the egress policy. Throws
 * {@link IntegrationSdkError} when the policy denies the host or the URL is
 * malformed. Credentials must already be resolved by the gateway and passed as
 * concrete header strings — this helper neither resolves refs nor reads
 * `process.env`.
 */
export async function httpRequest(url: string, opts: HttpRequestOptions): Promise<Response> {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    throw new IntegrationSdkError(`Invalid URL for httpRequest: "${url}"`)
  }
  const decision = opts.egress(host)
  if (!decision.allow) {
    throw new IntegrationSdkError(
      `Egress denied for host "${host}"${decision.reason ? `: ${decision.reason}` : ''}`,
    )
  }
  const doFetch = opts.fetchImpl ?? fetch
  return doFetch(url, {
    method: opts.method ?? 'GET',
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
}
