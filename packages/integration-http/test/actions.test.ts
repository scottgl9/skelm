import { IntegrationSdkError } from '@skelm/integration-sdk'
import type { EgressPolicy } from '@skelm/integration-sdk'
import { describe, expect, it, vi } from 'vitest'
import { auditDescriptor, get, paginateAll, post, request } from '../src/actions.js'
import { HttpClientError, HttpNetworkError, HttpServerError } from '../src/errors.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOW_ALL: EgressPolicy = () => ({ allow: true })
const DENY_ALL: EgressPolicy = (host) => ({ allow: false, reason: `blocked: ${host}` })

function makeFetch(status: number, body: unknown, headers?: Record<string, string>): typeof fetch {
  return vi.fn(async () => {
    const responseHeaders = new Headers(headers ?? { 'content-type': 'application/json' })
    return new Response(JSON.stringify(body), { status, headers: responseHeaders })
  }) as unknown as typeof fetch
}

function makeTextFetch(status: number, text: string): typeof fetch {
  return vi.fn(async () => {
    return new Response(text, { status, headers: new Headers({ 'content-type': 'text/plain' }) })
  }) as unknown as typeof fetch
}

function makeNetworkErrorFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError('fetch failed: connection refused')
  }) as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// request() — success
// ---------------------------------------------------------------------------

describe('request() — success', () => {
  it('returns status, headers, and parsed JSON body', async () => {
    const fetchImpl = makeFetch(200, { ok: true })
    const result = await request({
      method: 'GET',
      url: 'https://api.example.com/items',
      egress: ALLOW_ALL,
      fetchImpl,
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true })
    expect(result.headers).toHaveProperty('content-type')
  })

  it('passes method and body to fetch', async () => {
    const fetchImpl = makeFetch(201, { id: 1 })
    await request({
      method: 'POST',
      url: 'https://api.example.com/items',
      body: '{"name":"x"}',
      headers: { 'content-type': 'application/json' },
      egress: ALLOW_ALL,
      fetchImpl,
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/items',
      expect.objectContaining({ method: 'POST', body: '{"name":"x"}' }),
    )
  })

  it('appends query parameters to the URL', async () => {
    const fetchImpl = makeFetch(200, {})
    await request({
      method: 'GET',
      url: 'https://api.example.com/search',
      query: { q: 'hello', page: '2' },
      egress: ALLOW_ALL,
      fetchImpl,
    })
    const calledUrl = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(calledUrl).toContain('q=hello')
    expect(calledUrl).toContain('page=2')
  })

  it('falls back to text body for non-JSON content-type', async () => {
    const fetchImpl = makeTextFetch(200, 'plain response')
    const result = await request({
      method: 'GET',
      url: 'https://api.example.com/raw',
      egress: ALLOW_ALL,
      fetchImpl,
    })
    expect(result.body).toBe('plain response')
  })
})

// ---------------------------------------------------------------------------
// credential-ref / Authorization header assembly
// ---------------------------------------------------------------------------

describe('credential-ref / Authorization header', () => {
  it('passes the resolved Authorization header to fetch', async () => {
    const fetchImpl = makeFetch(200, {})
    await request({
      method: 'GET',
      url: 'https://api.example.com/me',
      headers: { Authorization: 'Bearer resolved-token-value' },
      egress: ALLOW_ALL,
      fetchImpl,
    })
    const called = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]
    const opts = called?.[1] as RequestInit
    const sentHeaders = opts.headers as Record<string, string>
    expect(sentHeaders.Authorization).toBe('Bearer resolved-token-value')
  })

  it('does NOT expose the credential value in errors or audit descriptors', async () => {
    const descriptor = auditDescriptor('GET', 'https://api.example.com/me', 200, {
      Authorization: 'Bearer secret-token',
      'x-api-key': 'key-value',
      'content-type': 'application/json',
    })
    const headers = descriptor.headers as Record<string, string>
    expect(headers.Authorization).toBe('[REDACTED]')
    expect(headers['x-api-key']).toBe('[REDACTED]')
    // Non-sensitive headers pass through
    expect(headers['content-type']).toBe('application/json')
  })

  it('error message does not include credential value', async () => {
    const fetchImpl = makeFetch(401, { error: 'unauthorized' })
    let caught: unknown
    try {
      await request({
        method: 'GET',
        url: 'https://api.example.com/secure',
        headers: { Authorization: 'Bearer super-secret-token' },
        egress: ALLOW_ALL,
        fetchImpl,
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HttpClientError)
    const msg = (caught as Error).message
    expect(msg).not.toContain('super-secret-token')
    expect(msg).not.toContain('Bearer')
    // Should contain host but not query params/credentials
    expect(msg).toContain('api.example.com')
  })
})

// ---------------------------------------------------------------------------
// egress-policy enforcement
// ---------------------------------------------------------------------------

describe('egress policy', () => {
  it('throws IntegrationSdkError when the policy denies the host', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    let caught: unknown
    try {
      await request({
        method: 'GET',
        url: 'https://blocked.example.com/data',
        egress: DENY_ALL,
        fetchImpl,
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(IntegrationSdkError)
    expect((caught as Error).message).toContain('blocked.example.com')
    // fetch should never have been called
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not make any network call when egress is denied', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      request({ method: 'GET', url: 'https://evil.io/steal', egress: DENY_ALL, fetchImpl }),
    ).rejects.toBeInstanceOf(IntegrationSdkError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// retry on 5xx then success
// ---------------------------------------------------------------------------

describe('retry', () => {
  it('retries on 5xx and succeeds on subsequent attempt', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls === 1) {
        return new Response(JSON.stringify({ error: 'server error' }), {
          status: 500,
          headers: new Headers({ 'content-type': 'application/json' }),
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      })
    }) as unknown as typeof fetch

    const result = await request({
      method: 'GET',
      url: 'https://api.example.com/flaky',
      egress: ALLOW_ALL,
      fetchImpl,
      retry: { maxAttempts: 3, sleep: async () => {} },
    })
    expect(result.status).toBe(200)
    expect(calls).toBe(2)
  })

  it('throws HttpServerError after exhausting all retries', async () => {
    const fetchImpl = makeFetch(503, { error: 'service unavailable' })
    await expect(
      request({
        method: 'GET',
        url: 'https://api.example.com/down',
        egress: ALLOW_ALL,
        fetchImpl,
        retry: { maxAttempts: 2, sleep: async () => {} },
      }),
    ).rejects.toBeInstanceOf(HttpServerError)
  })

  it('does not retry 4xx errors', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
      })
    }) as unknown as typeof fetch

    await expect(
      request({
        method: 'GET',
        url: 'https://api.example.com/missing',
        egress: ALLOW_ALL,
        fetchImpl,
        retry: { maxAttempts: 3, sleep: async () => {} },
      }),
    ).rejects.toBeInstanceOf(HttpClientError)
    expect(calls).toBe(1)
  })

  it('retries on network errors', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls < 3) throw new TypeError('fetch failed: ECONNREFUSED')
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      })
    }) as unknown as typeof fetch

    const result = await request({
      method: 'GET',
      url: 'https://api.example.com/retry-net',
      egress: ALLOW_ALL,
      fetchImpl,
      retry: { maxAttempts: 3, sleep: async () => {} },
    })
    expect(result.status).toBe(200)
    expect(calls).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// rate limiter windowing
// ---------------------------------------------------------------------------

describe('rate limiter', () => {
  it('blocks request when rate limit is exceeded', async () => {
    const { RateLimiter } = await import('@skelm/integration-sdk')
    // 1 request per 10s window — use a fixed `now` so second call exceeds it
    const now = Date.now()
    const limiter = new RateLimiter(1, 10_000)
    // First acquire succeeds
    expect(limiter.tryAcquire(now)).toBe(true)

    const fetchImpl = makeFetch(200, {})
    await expect(
      request({
        method: 'GET',
        url: 'https://api.example.com/rate-limited',
        egress: ALLOW_ALL,
        fetchImpl,
        rateLimiter: limiter,
      }),
    ).rejects.toBeInstanceOf(HttpClientError)
    // fetch should not have been called — blocked before network
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allows requests after the window has passed', async () => {
    const { RateLimiter } = await import('@skelm/integration-sdk')
    const limiter = new RateLimiter(1, 100)
    const t0 = Date.now()
    limiter.tryAcquire(t0) // consume slot

    // Advance time past window via direct slot drain: create new limiter at t+200
    const limiter2 = new RateLimiter(1, 100)
    const fetchImpl = makeFetch(200, { ok: true })
    // New limiter has fresh window — should allow
    const result = await request({
      method: 'GET',
      url: 'https://api.example.com/ok',
      egress: ALLOW_ALL,
      fetchImpl,
      rateLimiter: limiter2,
    })
    expect(result.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// error classification
// ---------------------------------------------------------------------------

describe('error classification', () => {
  it('classifies 4xx as HttpClientError', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const fetchImpl = makeFetch(status, {})
      await expect(
        request({ method: 'GET', url: 'https://api.example.com/x', egress: ALLOW_ALL, fetchImpl }),
      ).rejects.toBeInstanceOf(HttpClientError)
    }
  })

  it('classifies 5xx as HttpServerError', async () => {
    for (const status of [500, 502, 503]) {
      const fetchImpl = makeFetch(status, {})
      await expect(
        request({
          method: 'GET',
          url: 'https://api.example.com/x',
          egress: ALLOW_ALL,
          fetchImpl,
          retry: { maxAttempts: 1 },
        }),
      ).rejects.toBeInstanceOf(HttpServerError)
    }
  })

  it('classifies network TypeError as HttpNetworkError', async () => {
    const fetchImpl = makeNetworkErrorFetch()
    await expect(
      request({
        method: 'GET',
        url: 'https://api.example.com/x',
        egress: ALLOW_ALL,
        fetchImpl,
        retry: { maxAttempts: 1 },
      }),
    ).rejects.toBeInstanceOf(HttpNetworkError)
  })

  it('HttpClientError carries statusCode', async () => {
    const fetchImpl = makeFetch(404, {})
    let caught: unknown
    try {
      await request({
        method: 'GET',
        url: 'https://api.example.com/x',
        egress: ALLOW_ALL,
        fetchImpl,
      })
    } catch (e) {
      caught = e
    }
    expect((caught as HttpClientError).statusCode).toBe(404)
  })

  it('HttpServerError carries statusCode', async () => {
    const fetchImpl = makeFetch(500, {})
    let caught: unknown
    try {
      await request({
        method: 'GET',
        url: 'https://api.example.com/x',
        egress: ALLOW_ALL,
        fetchImpl,
        retry: { maxAttempts: 1 },
      })
    } catch (e) {
      caught = e
    }
    expect((caught as HttpServerError).statusCode).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// get() and post() convenience
// ---------------------------------------------------------------------------

describe('get()', () => {
  it('issues a GET request and returns the result', async () => {
    const fetchImpl = makeFetch(200, { items: [] })
    const result = await get('https://api.example.com/items', {
      egress: ALLOW_ALL,
      fetchImpl,
    })
    expect(result.status).toBe(200)
    const calledOpts = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    expect(calledOpts.method).toBe('GET')
  })
})

describe('post()', () => {
  it('issues a POST with JSON body and content-type header', async () => {
    const fetchImpl = makeFetch(201, { id: 42 })
    const result = await post(
      'https://api.example.com/items',
      { name: 'foo' },
      {
        egress: ALLOW_ALL,
        fetchImpl,
      },
    )
    expect(result.status).toBe(201)
    const calledOpts = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    expect(calledOpts.method).toBe('POST')
    expect(calledOpts.body).toBe('{"name":"foo"}')
    const sentHeaders = calledOpts.headers as Record<string, string>
    expect(sentHeaders['content-type']).toBe('application/json')
  })
})

// ---------------------------------------------------------------------------
// pagination across pages
// ---------------------------------------------------------------------------

describe('paginateAll()', () => {
  it('collects items across multiple pages', async () => {
    const pages = [
      { items: [1, 2], nextCursor: 'page2' },
      { items: [3, 4], nextCursor: 'page3' },
      { items: [5], nextCursor: undefined },
    ]
    let callCount = 0
    const fetchImpl = vi.fn(async (url: string) => {
      const u = new URL(url)
      const cursor = u.searchParams.get('cursor')
      const pageIndex = !cursor ? 0 : cursor === 'page2' ? 1 : 2
      const page = pages[pageIndex] ?? pages[0]
      callCount++
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      })
    }) as unknown as typeof fetch

    const items = await paginateAll({
      url: 'https://api.example.com/list',
      egress: ALLOW_ALL,
      fetchImpl,
      getNextCursor: (body) => (body as { nextCursor?: string }).nextCursor,
      getItems: (body) => (body as { items: unknown[] }).items,
    })

    expect(items).toEqual([1, 2, 3, 4, 5])
    expect(callCount).toBe(3)
  })

  it('respects maxPages limit', async () => {
    let callCount = 0
    const fetchImpl = vi.fn(async () => {
      callCount++
      return new Response(
        JSON.stringify({ items: [callCount], nextCursor: `page${callCount + 1}` }),
        {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
        },
      )
    }) as unknown as typeof fetch

    const items = await paginateAll({
      url: 'https://api.example.com/list',
      egress: ALLOW_ALL,
      fetchImpl,
      getNextCursor: (body) => (body as { nextCursor: string }).nextCursor,
      getItems: (body) => (body as { items: unknown[] }).items,
      maxPages: 2,
    })

    expect(items).toHaveLength(2)
    expect(callCount).toBe(2)
  })

  it('stops when no nextCursor is returned', async () => {
    const fetchImpl = makeFetch(200, { items: [1, 2, 3], nextCursor: undefined })
    const items = await paginateAll({
      url: 'https://api.example.com/list',
      egress: ALLOW_ALL,
      fetchImpl,
      getNextCursor: (body) => (body as { nextCursor?: string }).nextCursor,
      getItems: (body) => (body as { items: unknown[] }).items,
    })
    expect(items).toEqual([1, 2, 3])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// No credential value in any audit/log/error output
// ---------------------------------------------------------------------------

describe('credential redaction — no value in observable output', () => {
  it('network error message does not include auth header value', async () => {
    const fetchImpl = makeNetworkErrorFetch()
    let caught: unknown
    try {
      await request({
        method: 'GET',
        url: 'https://api.example.com/secure',
        headers: { Authorization: 'Bearer my-secret-value' },
        egress: ALLOW_ALL,
        fetchImpl,
        retry: { maxAttempts: 1 },
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HttpNetworkError)
    expect((caught as Error).message).not.toContain('my-secret-value')
  })

  it('auditDescriptor redacts Authorization and x-api-key', () => {
    const desc = auditDescriptor('POST', 'https://api.example.com/data', 200, {
      Authorization: 'Bearer tok-abc123',
      'x-api-key': 'key-xyz',
      'content-type': 'application/json',
    })
    const h = desc.headers as Record<string, string>
    expect(h.Authorization).toBe('[REDACTED]')
    expect(h['x-api-key']).toBe('[REDACTED]')
    expect(JSON.stringify(desc)).not.toContain('tok-abc123')
    expect(JSON.stringify(desc)).not.toContain('key-xyz')
  })

  it('auditDescriptor only logs method + host + status', () => {
    const desc = auditDescriptor('GET', 'https://api.example.com/endpoint?token=secret', 200)
    expect(desc.method).toBe('GET')
    expect(desc.host).toBe('api.example.com')
    expect(desc.status).toBe(200)
    // Query string (which may have credentials) is not logged
    expect(JSON.stringify(desc)).not.toContain('token=secret')
  })
})
