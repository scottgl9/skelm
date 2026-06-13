import { IntegrationCredentialsError, IntegrationRateLimitError } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'
import { NOTION_VERSION, NotionApiError, createNotionClient } from '../src/index.js'
import { allowAll, denyAll, fakeFetch } from './helpers.js'

const TOKEN = 'secret_ntn_super_sensitive_token_value'

describe('createNotionClient request shaping', () => {
  it('sends the Notion-Version header, bearer auth, and JSON content-type on a body request', async () => {
    const f = fakeFetch([{ body: { object: 'page', id: 'p1', properties: {} } }])
    const client = createNotionClient(
      { token: TOKEN },
      { egress: allowAll, fetchImpl: f.fetchImpl },
    )

    await client.request({ method: 'POST', path: '/v1/pages', body: { parent: { page_id: 'x' } } })

    expect(f.requests).toHaveLength(1)
    const req = f.requestAt(0)
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://api.notion.com/v1/pages')
    expect(req.headers['notion-version']).toBe(NOTION_VERSION)
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(req.headers['content-type']).toBe('application/json')
    expect(f.bodyAt(0)).toEqual({ parent: { page_id: 'x' } })
  })

  it('omits content-type on a bodiless GET but still sends version + auth', async () => {
    const f = fakeFetch([{ body: { object: 'user', id: 'u1' } }])
    const client = createNotionClient(
      { token: TOKEN },
      { egress: allowAll, fetchImpl: f.fetchImpl },
    )

    await client.request({ method: 'GET', path: '/v1/users/me' })

    const req = f.requestAt(0)
    expect(req.headers['notion-version']).toBe(NOTION_VERSION)
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(req.headers['content-type']).toBeUndefined()
    expect(req.body).toBeUndefined()
  })

  it('appends query parameters', async () => {
    const f = fakeFetch([{ body: {} }])
    const client = createNotionClient(
      { token: TOKEN },
      { egress: allowAll, fetchImpl: f.fetchImpl },
    )

    await client.request({
      method: 'GET',
      path: '/v1/blocks/b1/children',
      query: { page_size: '50' },
    })

    expect(f.requestAt(0).url).toBe('https://api.notion.com/v1/blocks/b1/children?page_size=50')
  })

  it('honors a baseUrl override', async () => {
    const f = fakeFetch([{ body: {} }])
    const client = createNotionClient(
      { token: TOKEN },
      { egress: allowAll, fetchImpl: f.fetchImpl, baseUrl: 'https://notion.internal.test' },
    )

    await client.request({ method: 'GET', path: '/v1/users/me' })

    expect(f.requestAt(0).url).toBe('https://notion.internal.test/v1/users/me')
  })

  it('returns undefined for a 204 response', async () => {
    const f = fakeFetch([{ status: 204 }])
    const client = createNotionClient(
      { token: TOKEN },
      { egress: allowAll, fetchImpl: f.fetchImpl },
    )
    await expect(
      client.request({ method: 'DELETE', path: '/v1/blocks/b1' }),
    ).resolves.toBeUndefined()
  })
})

describe('createNotionClient auth assembly', () => {
  it('rejects an empty token before any request', () => {
    expect(() => createNotionClient({ token: '' }, { egress: allowAll })).toThrow(
      IntegrationCredentialsError,
    )
  })
})

describe('createNotionClient egress enforcement', () => {
  it('blocks the request when egress denies the host and never calls fetch', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as typeof fetch
    const client = createNotionClient({ token: TOKEN }, { egress: denyAll, fetchImpl })

    await expect(client.request({ method: 'GET', path: '/v1/users/me' })).rejects.toThrow(
      /Egress denied/,
    )
    expect(called).toBe(false)
  })
})

describe('createNotionClient error classification', () => {
  it('classifies 429 as a retryable rate-limit error', async () => {
    const f = fakeFetch([
      {
        status: 429,
        body: { object: 'error', status: 429, code: 'rate_limited', message: 'slow down' },
      },
      {
        status: 429,
        body: { object: 'error', status: 429, code: 'rate_limited', message: 'slow down' },
      },
      {
        status: 429,
        body: { object: 'error', status: 429, code: 'rate_limited', message: 'slow down' },
      },
    ])
    const client = createNotionClient(
      { token: TOKEN },
      { egress: allowAll, fetchImpl: f.fetchImpl, retry: { sleep: async () => {} } },
    )

    await expect(client.request({ method: 'GET', path: '/v1/users/me' })).rejects.toBeInstanceOf(
      IntegrationRateLimitError,
    )
    expect(f.requests).toHaveLength(3)
  })

  it('retries 5xx then succeeds', async () => {
    const f = fakeFetch([
      { status: 502, body: { object: 'error', status: 502, code: 'bad_gateway', message: 'oops' } },
      { body: { object: 'user', id: 'u1', name: 'bot' } },
    ])
    const client = createNotionClient(
      { token: TOKEN },
      { egress: allowAll, fetchImpl: f.fetchImpl, retry: { sleep: async () => {} } },
    )

    const res = await client.request<{ id: string }>({ method: 'GET', path: '/v1/users/me' })
    expect(res.id).toBe('u1')
    expect(f.requests).toHaveLength(2)
  })

  it('does not retry a 4xx and surfaces a typed NotionApiError with code', async () => {
    const f = fakeFetch([
      {
        status: 401,
        body: {
          object: 'error',
          status: 401,
          code: 'unauthorized',
          message: 'API token is invalid.',
        },
      },
    ])
    const client = createNotionClient(
      { token: TOKEN },
      { egress: allowAll, fetchImpl: f.fetchImpl, retry: { sleep: async () => {} } },
    )

    await expect(client.request({ method: 'GET', path: '/v1/users/me' })).rejects.toMatchObject({
      name: 'NotionApiError',
      statusCode: 401,
      code: 'unauthorized',
    })
    expect(f.requests).toHaveLength(1)
  })

  it('tolerates a non-JSON error body', async () => {
    const f = fakeFetch([{ status: 500, text: '<html>gateway error</html>' }])
    const client = createNotionClient(
      { token: TOKEN },
      { egress: allowAll, fetchImpl: f.fetchImpl, retry: { maxAttempts: 1 } },
    )

    const err = await client.request({ method: 'GET', path: '/v1/users/me' }).catch((e) => e)
    expect(err).toBeInstanceOf(NotionApiError)
    expect((err as NotionApiError).statusCode).toBe(500)
  })
})

describe('token redaction', () => {
  it('never includes the token in error messages', async () => {
    const f = fakeFetch([
      {
        status: 401,
        body: {
          object: 'error',
          status: 401,
          code: 'unauthorized',
          message: 'API token is invalid.',
        },
      },
    ])
    const client = createNotionClient(
      { token: TOKEN },
      { egress: allowAll, fetchImpl: f.fetchImpl, retry: { maxAttempts: 1 } },
    )

    const err = await client.request({ method: 'GET', path: '/v1/users/me' }).catch((e) => e)
    expect(String(err)).not.toContain(TOKEN)
    expect((err as Error).stack ?? '').not.toContain(TOKEN)
  })
})
