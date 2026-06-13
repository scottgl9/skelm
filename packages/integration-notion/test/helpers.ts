import type { EgressPolicy } from '@skelm/integration-sdk'

/** One recorded outbound request the fake fetch captured. */
export interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

/** A canned response the fake fetch returns, in order. */
export interface CannedResponse {
  readonly status?: number
  readonly body?: unknown
  /** Raw text body override (used to simulate non-JSON error pages). */
  readonly text?: string
}

export interface FakeFetch {
  readonly fetchImpl: typeof fetch
  readonly requests: RecordedRequest[]
  /** The recorded request at `index`, asserted present. */
  requestAt(index: number): RecordedRequest
  /** The parsed JSON body of the request at `index`. */
  bodyAt(index: number): Record<string, unknown>
}

/**
 * Build a fetch stub that returns `responses` in order. Captures every request
 * (url/method/headers/body) so tests can assert request shaping. Header keys
 * are lower-cased for stable lookup.
 */
export function fakeFetch(responses: readonly CannedResponse[]): FakeFetch {
  const requests: RecordedRequest[] = []
  let i = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const headers: Record<string, string> = {}
    const raw = init?.headers as Record<string, string> | undefined
    if (raw) for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = v
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    const canned = responses[Math.min(i, responses.length - 1)]
    i++
    const status = canned?.status ?? 200
    const text = canned?.text ?? JSON.stringify(canned?.body ?? {})
    return new Response(status === 204 ? null : text, {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const requestAt = (index: number): RecordedRequest => {
    const req = requests[index]
    if (req === undefined) throw new Error(`no recorded request at index ${index}`)
    return req
  }
  const bodyAt = (index: number): Record<string, unknown> => {
    const { body } = requestAt(index)
    return body === undefined ? {} : (JSON.parse(body) as Record<string, unknown>)
  }
  return { fetchImpl, requests, requestAt, bodyAt }
}

/** Egress policy that allows every host. */
export const allowAll: EgressPolicy = () => ({ allow: true })

/** Egress policy that denies every host with a reason. */
export const denyAll: EgressPolicy = (host) => ({ allow: false, reason: `${host} not allowed` })
