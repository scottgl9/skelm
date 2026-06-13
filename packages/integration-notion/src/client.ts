/**
 * Egress-gated Notion API transport.
 *
 * SECURITY: the integration token never originates here and is never read from
 * `process.env`. The gateway resolves a {@link CredentialReference} to an
 * ephemeral token and hands it to {@link createNotionClient} for the duration of
 * one dispatch; the client uses it only to build the `Authorization` header and
 * never logs or persists it. Every request goes through the SDK's
 * {@link httpRequest}, which consults a required {@link EgressPolicy}, so the
 * client can never reach a host the gateway has not allowed.
 */

import {
  type EgressPolicy,
  IntegrationCredentialsError,
  IntegrationRateLimitError,
  IntegrationSdkError,
  type RetryOptions,
  httpRequest,
  withRetry,
} from '@skelm/integration-sdk'

/** Notion REST API version pinned via the required `Notion-Version` header. */
export const NOTION_VERSION = '2022-06-28'

/** Default Notion API origin. */
export const NOTION_API_BASE = 'https://api.notion.com'

/**
 * A resolved integration token, supplied by the gateway for one dispatch. This
 * is the only place a concrete secret value enters the client; it is used to
 * build the bearer header and is never stored beyond the request closure.
 */
export interface NotionAuth {
  /** Ephemeral integration token resolved by the gateway. Never logged. */
  readonly token: string
}

export interface NotionClientOptions {
  /** Required egress hook; the gateway supplies it. */
  readonly egress: EgressPolicy
  /** API origin override (tests/self-host). Defaults to {@link NOTION_API_BASE}. */
  readonly baseUrl?: string
  /** Injected fetch for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
  /** Retry policy for transient/rate-limited failures. */
  readonly retry?: RetryOptions
}

export interface NotionRequest {
  readonly method: string
  /** API path beginning with `/v1/...`. */
  readonly path: string
  /** JSON body; serialized by the client. */
  readonly body?: unknown
  /** Query-string parameters appended to the path. */
  readonly query?: Readonly<Record<string, string>>
}

/** The minimal Notion transport every action is built on. */
export interface NotionClient {
  request<T = unknown>(req: NotionRequest): Promise<T>
}

interface NotionErrorBody {
  readonly object?: string
  readonly status?: number
  readonly code?: string
  readonly message?: string
}

/**
 * Decide whether a Notion failure is worth retrying: 429 rate limits and 5xx
 * server errors are transient; everything else (4xx auth/validation) is not.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof IntegrationRateLimitError) return true
  if (error instanceof NotionApiError) return error.statusCode >= 500
  return false
}

/** A typed error carrying Notion's `code`/`status` without any token material. */
export class NotionApiError extends IntegrationSdkError {
  override readonly name = 'NotionApiError'
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

function buildUrl(baseUrl: string, path: string, query?: Readonly<Record<string, string>>): string {
  const url = new URL(path, baseUrl)
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  }
  return url.toString()
}

/**
 * Create a Notion client bound to an ephemeral token. The token is captured in
 * the request closure only; it is never written to logs, audit, or errors. The
 * `Notion-Version` header is sent on every request.
 */
export function createNotionClient(auth: NotionAuth, opts: NotionClientOptions): NotionClient {
  if (typeof auth.token !== 'string' || auth.token.length === 0) {
    throw new IntegrationCredentialsError('Notion integration token is missing or empty')
  }
  const baseUrl = opts.baseUrl ?? NOTION_API_BASE

  async function once<T>(req: NotionRequest): Promise<T> {
    const url = buildUrl(baseUrl, req.path, req.query)
    const headers: Record<string, string> = {
      authorization: `Bearer ${auth.token}`,
      'notion-version': NOTION_VERSION,
    }
    const hasBody = req.body !== undefined
    if (hasBody) headers['content-type'] = 'application/json'

    const response = await httpRequest(url, {
      method: req.method,
      headers,
      egress: opts.egress,
      ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    })

    if (response.ok) {
      if (response.status === 204) return undefined as T
      return (await response.json()) as T
    }

    const detail = await readErrorBody(response)
    const message = `Notion API ${response.status}${detail.code ? ` (${detail.code})` : ''}: ${
      detail.message ?? response.statusText
    }`
    if (response.status === 429) {
      throw new IntegrationRateLimitError(message)
    }
    throw new NotionApiError(message, response.status, detail.code)
  }

  return {
    request<T = unknown>(req: NotionRequest): Promise<T> {
      return withRetry(() => once<T>(req), { isRetryable, ...opts.retry })
    },
  }
}

async function readErrorBody(response: Response): Promise<NotionErrorBody> {
  try {
    const parsed = (await response.json()) as NotionErrorBody
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
