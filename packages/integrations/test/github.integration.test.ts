import type { GitHubConfig } from '@skelm/integration-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GitHubApiError,
  GitHubIntegration,
  deleteWebhook,
  getAuthenticatedUser,
  postIssueComment,
  postPullRequestReview,
  registerWebhook,
} from '../src/github.js'

interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function mockFetch(handler: (req: RecordedRequest) => Response): RecordedRequest[] {
  const calls: RecordedRequest[] = []
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    const recorded: RecordedRequest = {
      url: input,
      method: init?.method ?? 'GET',
      headers,
      body,
    }
    calls.push(recorded)
    return handler(recorded)
  })
  return calls
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      ...extraHeaders,
    },
  })
}

const AUTH = { token: 'ghp_test' }
const CREDS = { token: 'ghp_test', ownerId: 'octo', repoName: 'demo' }
const CONFIG: GitHubConfig = {
  id: 'github',
  name: 'GitHub',
  enabled: true,
  credentials: CREDS,
}

describe('github REST helpers', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('getAuthenticatedUser issues GET /user with bearer auth and standard headers', async () => {
    const calls = mockFetch(() => jsonResponse(200, { login: 'octo', id: 1 }))
    const user = await getAuthenticatedUser(AUTH)
    expect(user).toEqual({ login: 'octo', id: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.github.com/user')
    expect(calls[0].method).toBe('GET')
    expect(calls[0].headers.authorization).toBe('Bearer ghp_test')
    expect(calls[0].headers.accept).toBe('application/vnd.github+json')
    expect(calls[0].headers['x-github-api-version']).toBe('2022-11-28')
  })

  it('registerWebhook POSTs the hook config and returns the created id', async () => {
    const calls = mockFetch(() =>
      jsonResponse(201, { id: 42, url: 'https://api.github.com/repos/octo/demo/hooks/42' }),
    )
    const hook = await registerWebhook({
      auth: AUTH,
      owner: 'octo',
      repo: 'demo',
      url: 'https://example.com/hook',
      secret: 's3cr3t',
      events: ['pull_request', 'issue_comment'],
    })
    expect(hook).toEqual({ id: 42, url: 'https://api.github.com/repos/octo/demo/hooks/42' })
    expect(calls[0].url).toBe('https://api.github.com/repos/octo/demo/hooks')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual({
      name: 'web',
      active: true,
      events: ['pull_request', 'issue_comment'],
      config: { url: 'https://example.com/hook', content_type: 'json', secret: 's3cr3t' },
    })
  })

  it('deleteWebhook issues DELETE /hooks/:id', async () => {
    const calls = mockFetch(() => new Response(null, { status: 204 }))
    await deleteWebhook({ auth: AUTH, owner: 'octo', repo: 'demo', hookId: 42 })
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe('https://api.github.com/repos/octo/demo/hooks/42')
  })

  it('postIssueComment POSTs to /issues/:n/comments and returns id + html url', async () => {
    const calls = mockFetch(() =>
      jsonResponse(201, {
        id: 7,
        html_url: 'https://github.com/octo/demo/issues/3#issuecomment-7',
      }),
    )
    const res = await postIssueComment({
      auth: AUTH,
      owner: 'octo',
      repo: 'demo',
      number: 3,
      body: 'hello',
    })
    expect(res).toEqual({
      id: 7,
      htmlUrl: 'https://github.com/octo/demo/issues/3#issuecomment-7',
    })
    expect(calls[0].url).toBe('https://api.github.com/repos/octo/demo/issues/3/comments')
    expect(calls[0].body).toEqual({ body: 'hello' })
  })

  it('postPullRequestReview POSTs to /pulls/:n/reviews with event + inline comments', async () => {
    const calls = mockFetch(() =>
      jsonResponse(200, { id: 99, html_url: 'https://github.com/octo/demo/pull/5#review-99' }),
    )
    const res = await postPullRequestReview({
      auth: AUTH,
      owner: 'octo',
      repo: 'demo',
      number: 5,
      event: 'REQUEST_CHANGES',
      body: 'see comments',
      comments: [{ path: 'src/x.ts', line: 12, body: 'nit: rename' }],
    })
    expect(res).toEqual({ id: 99, htmlUrl: 'https://github.com/octo/demo/pull/5#review-99' })
    expect(calls[0].url).toBe('https://api.github.com/repos/octo/demo/pulls/5/reviews')
    expect(calls[0].body).toEqual({
      event: 'REQUEST_CHANGES',
      body: 'see comments',
      comments: [{ path: 'src/x.ts', line: 12, body: 'nit: rename' }],
    })
  })

  it('throws GitHubApiError with status + parsed body on non-2xx', async () => {
    mockFetch(() => jsonResponse(422, { message: 'Validation Failed' }))
    await expect(
      postIssueComment({ auth: AUTH, owner: 'octo', repo: 'demo', number: 1, body: '' }),
    ).rejects.toMatchObject({
      name: 'GitHubApiError',
      status: 422,
    })
  })

  it('warns on stderr when rate-limit budget falls below 10%', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockFetch(() =>
      jsonResponse(
        200,
        { login: 'x', id: 1 },
        { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '100' },
      ),
    )
    await getAuthenticatedUser(AUTH)
    expect(writeSpy).toHaveBeenCalled()
    const arg = String(writeSpy.mock.calls[0][0])
    expect(arg).toContain('rate limit warning')
    writeSpy.mockRestore()
  })
})

describe('GitHubIntegration — wired to REST', () => {
  let github: InstanceType<typeof GitHubIntegration>

  beforeEach(async () => {
    github = new GitHubIntegration(CONFIG)
    await github.init()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('performHealthCheck calls GET /user and returns true on 200', async () => {
    const calls = mockFetch(() => jsonResponse(200, { login: 'octo', id: 1 }))
    const ok = await github.healthCheck()
    expect(ok).toBe(true)
    expect(calls[0].url).toBe('https://api.github.com/user')
  })

  it('performHealthCheck returns false on 401 (bad token)', async () => {
    mockFetch(() => jsonResponse(401, { message: 'Bad credentials' }))
    const ok = await github.healthCheck()
    expect(ok).toBe(false)
  })

  it('sendNotification routes to issue comments by default', async () => {
    const calls = mockFetch(() => jsonResponse(201, { id: 1, html_url: 'x' }))
    await github.sendNotification('hi', { number: 3 })
    expect(calls[0].url).toBe('https://api.github.com/repos/octo/demo/issues/3/comments')
    expect(calls[0].body).toEqual({ body: 'hi' })
  })

  it('sendNotification routes to PR review when kind=pr-review', async () => {
    const calls = mockFetch(() => jsonResponse(200, { id: 1, html_url: 'x' }))
    await github.sendNotification('looks good', {
      kind: 'pr-review',
      number: 7,
      event: 'APPROVE',
    })
    expect(calls[0].url).toBe('https://api.github.com/repos/octo/demo/pulls/7/reviews')
    expect(calls[0].body).toEqual({ event: 'APPROVE', body: 'looks good' })
  })

  it('sendNotification throws when options.number is missing', async () => {
    mockFetch(() => jsonResponse(200, {}))
    await expect(github.sendNotification('x', {})).rejects.toThrow(/options\.number/)
  })
})

describe('GitHubApiError', () => {
  it('formats a useful message including method, path, and body.message', () => {
    const err = new GitHubApiError(404, 'GET', '/repos/x/y', { message: 'Not Found' })
    expect(err.message).toContain('GET /repos/x/y')
    expect(err.message).toContain('404')
    expect(err.message).toContain('Not Found')
  })
})
