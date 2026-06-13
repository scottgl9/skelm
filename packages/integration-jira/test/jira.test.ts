import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  JiraApiError,
  JiraClient,
  type JiraResolvedCredentials,
  addComment,
  basicAuthHeader,
  buildPollJql,
  checkJiraHealth,
  createIssue,
  getIssue,
  getMyself,
  isRetryableJiraError,
  jiraManifest,
  normalizeJiraWebhook,
  searchIssuesAll,
  transitionIssue,
  updateIssue,
  verifyJiraWebhook,
} from '../src/index.js'

const BASE = 'https://acme.atlassian.net'
const CREDS: JiraResolvedCredentials = { email: 'bot@acme.io', apiToken: 'sekret-token-xyz' }
const ALLOW_ALL = () => ({ allow: true })

interface Recorded {
  url: string
  init: RequestInit
}

/** A fetch stub that records calls and returns scripted responses by index/match. */
function stubFetch(
  responder: (
    url: string,
    init: RequestInit,
  ) => { status?: number; body?: unknown; headers?: Record<string, string> },
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const i = init ?? {}
    calls.push({ url, init: i })
    const r = responder(url, i)
    const status = r.status ?? 200
    const bodyText = r.body === undefined ? '' : JSON.stringify(r.body)
    return new Response(bodyText, {
      status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function client(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof JiraClient>[0]> = {},
): JiraClient {
  return new JiraClient({
    baseUrl: BASE,
    credentials: CREDS,
    egress: ALLOW_ALL,
    fetchImpl,
    ...extra,
  })
}

// ---------------------------------------------------------------------------
// Credential assembly: token on the wire, never in logs
// ---------------------------------------------------------------------------

describe('credential assembly', () => {
  it('encodes Basic auth from email + token', () => {
    const header = basicAuthHeader(CREDS)
    const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString('utf8')
    expect(decoded).toBe('bot@acme.io:sekret-token-xyz')
  })

  it('sends the Authorization header on outbound requests', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: { accountId: 'a1' } }))
    await getMyself(client(fetchImpl))
    const auth = (calls[0]?.init.headers as Record<string, string>).Authorization
    expect(auth).toMatch(/^Basic /)
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString('utf8')).toContain(
      'sekret-token-xyz',
    )
  })

  it('does not leak the token into thrown error messages', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 400,
      body: { errorMessages: ['bad request'] },
    }))
    let captured: unknown
    try {
      await getIssue(client(fetchImpl), { issueIdOrKey: 'TEST-1' })
    } catch (e) {
      captured = e
    }
    expect(captured).toBeInstanceOf(JiraApiError)
    const err = captured as JiraApiError
    expect(err.message).not.toContain('sekret-token-xyz')
    expect(JSON.stringify(err.body)).not.toContain('sekret-token-xyz')
  })
})

// ---------------------------------------------------------------------------
// Egress policy
// ---------------------------------------------------------------------------

describe('egress policy', () => {
  it('blocks a denied host before any fetch', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: {} }))
    const denied = client(fetchImpl, {
      egress: (h) => ({ allow: false, reason: `host ${h} not allowed` }),
    })
    await expect(getMyself(denied)).rejects.toThrow(/Egress denied/)
    expect(calls).toHaveLength(0)
  })

  it('passes the request host to the egress hook', async () => {
    const seen: string[] = []
    const { fetchImpl } = stubFetch(() => ({ body: { accountId: 'a1' } }))
    await getMyself(
      client(fetchImpl, {
        egress: (h) => {
          seen.push(h)
          return { allow: true }
        },
      }),
    )
    expect(seen).toEqual(['acme.atlassian.net'])
  })
})

// ---------------------------------------------------------------------------
// Action request shaping + response mapping
// ---------------------------------------------------------------------------

describe('actions', () => {
  it('createIssue posts ADF description and maps the created issue', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 201,
      body: { id: '10001', key: 'TEST-1', self: 's' },
    }))
    const res = await createIssue(client(fetchImpl), {
      projectKey: 'TEST',
      issueType: 'Task',
      summary: 'hello',
      description: 'world',
      fields: { labels: ['x'] },
    })
    expect(res).toEqual({ id: '10001', key: 'TEST-1', self: 's' })
    expect(calls[0]?.url).toBe(`${BASE}/rest/api/3/issue`)
    const body = JSON.parse(calls[0]?.init.body as string)
    expect(body.fields.project).toEqual({ key: 'TEST' })
    expect(body.fields.issuetype).toEqual({ name: 'Task' })
    expect(body.fields.summary).toBe('hello')
    expect(body.fields.description.type).toBe('doc')
    expect(body.fields.labels).toEqual(['x'])
  })

  it('getIssue maps fields and forwards a fields filter', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      body: { id: '1', key: 'K-1', self: 's', fields: { summary: 'x' } },
    }))
    const issue = await getIssue(client(fetchImpl), {
      issueIdOrKey: 'K-1',
      fields: ['summary', 'status'],
    })
    expect(issue.key).toBe('K-1')
    expect(calls[0]?.url).toBe(`${BASE}/rest/api/3/issue/K-1?fields=summary%2Cstatus`)
  })

  it('updateIssue PUTs fields and wraps a string description as ADF', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200 }))
    await updateIssue(client(fetchImpl), {
      issueIdOrKey: 'K-1',
      fields: { summary: 'new', description: 'desc' },
    })
    expect(calls[0]?.init.method).toBe('PUT')
    const body = JSON.parse(calls[0]?.init.body as string)
    expect(body.fields.summary).toBe('new')
    expect(body.fields.description.type).toBe('doc')
  })

  it('transitionIssue posts the transition id', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200 }))
    await transitionIssue(client(fetchImpl), { issueIdOrKey: 'K-1', transitionId: '31' })
    expect(calls[0]?.url).toBe(`${BASE}/rest/api/3/issue/K-1/transitions`)
    expect(JSON.parse(calls[0]?.init.body as string).transition).toEqual({ id: '31' })
  })

  it('addComment posts an ADF comment and maps the result', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 201, body: { id: 'c1', self: 'cs' } }))
    const res = await addComment(client(fetchImpl), { issueIdOrKey: 'K-1', body: 'nice' })
    expect(res).toEqual({ id: 'c1', self: 'cs' })
    expect(JSON.parse(calls[0]?.init.body as string).body.type).toBe('doc')
  })
})

// ---------------------------------------------------------------------------
// JQL pagination across pages
// ---------------------------------------------------------------------------

describe('JQL search pagination', () => {
  it('walks the nextPageToken cursor to exhaustion', async () => {
    const seenCursors: (string | undefined)[] = []
    const { fetchImpl } = stubFetch((_url, init) => {
      const body = JSON.parse(init.body as string)
      seenCursors.push(body.nextPageToken)
      if (body.nextPageToken === undefined) {
        return {
          body: { issues: [{ id: '1', key: 'A-1', self: 's', fields: {} }], nextPageToken: 'c2' },
        }
      }
      return { body: { issues: [{ id: '2', key: 'A-2', self: 's', fields: {} }] } }
    })
    const issues = await searchIssuesAll(client(fetchImpl), { jql: 'project = A' })
    expect(issues.map((i) => i.key)).toEqual(['A-1', 'A-2'])
    expect(seenCursors).toEqual([undefined, 'c2'])
  })

  it('respects maxPages', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: { issues: [{ id: '1', key: 'A-1', self: 's', fields: {} }], nextPageToken: 'always' },
    }))
    const issues = await searchIssuesAll(client(fetchImpl), { jql: 'x', maxPages: 2 })
    expect(issues).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Retry / rate-limit classification
// ---------------------------------------------------------------------------

describe('retry + rate-limit classification', () => {
  it('classifies 429 and 5xx as retryable, 4xx as not', () => {
    expect(isRetryableJiraError(new JiraApiError(429, 'GET', '/x', null))).toBe(true)
    expect(isRetryableJiraError(new JiraApiError(503, 'GET', '/x', null))).toBe(true)
    expect(isRetryableJiraError(new JiraApiError(400, 'GET', '/x', null))).toBe(false)
    expect(isRetryableJiraError(new JiraApiError(404, 'GET', '/x', null))).toBe(false)
  })

  it('retries a transient 503 then succeeds', async () => {
    let n = 0
    const { fetchImpl } = stubFetch(() => {
      n++
      return n === 1
        ? { status: 503, body: { errorMessages: ['busy'] } }
        : { body: { accountId: 'a1' } }
    })
    const me = await getMyself(
      client(fetchImpl, { retry: { sleep: async () => {}, maxAttempts: 3 } }),
    )
    expect(me.accountId).toBe('a1')
    expect(n).toBe(2)
  })

  it('does not retry a 400', async () => {
    let n = 0
    const { fetchImpl } = stubFetch(() => {
      n++
      return { status: 400, body: { errorMessages: ['nope'] } }
    })
    await expect(
      getMyself(client(fetchImpl, { retry: { sleep: async () => {} } })),
    ).rejects.toThrow(JiraApiError)
    expect(n).toBe(1)
  })

  it('parses Retry-After on a 429', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 429,
      body: {},
      headers: { 'retry-after': '7' },
    }))
    let captured: JiraApiError | undefined
    try {
      await getMyself(client(fetchImpl, { retry: { maxAttempts: 1, sleep: async () => {} } }))
    } catch (e) {
      captured = e as JiraApiError
    }
    expect(captured?.retryAfterSeconds).toBe(7)
  })

  it('throws a client-side 429 when the local rate limiter is exhausted', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: { accountId: 'a1' } }))
    const c = client(fetchImpl, {
      rateLimit: { requests: 1, windowMs: 60_000 },
      retry: { maxAttempts: 1, sleep: async () => {} },
    })
    await getMyself(c)
    await expect(getMyself(c)).rejects.toThrow(/rate limit/)
  })
})

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe('health check', () => {
  it('reports ok on a successful /myself', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: { accountId: 'a1', displayName: 'Bot' } }))
    const h = await checkJiraHealth(client(fetchImpl))
    expect(h).toMatchObject({ healthy: true, status: 'ok' })
    expect(h.detail).not.toContain('sekret-token-xyz')
  })

  it('reports unhealthy on 401', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 401, body: { errorMessages: ['unauth'] } }))
    const h = await checkJiraHealth(
      client(fetchImpl, { retry: { maxAttempts: 1, sleep: async () => {} } }),
    )
    expect(h).toMatchObject({ healthy: false, status: 'unhealthy' })
    expect(h.detail).not.toContain('sekret-token-xyz')
  })
})

// ---------------------------------------------------------------------------
// Webhook verify + normalize
// ---------------------------------------------------------------------------

describe('webhook verification', () => {
  const secret = 'shared'
  const payload = JSON.stringify({
    webhookEvent: 'jira:issue_created',
    timestamp: 1,
    issue: { id: '9' },
  })

  function sign(p: string): string {
    return createHmac('sha256', secret).update(p).digest('hex')
  }

  it('accepts a valid HMAC signature', () => {
    expect(verifyJiraWebhook({ payload, signature: sign(payload), secret })).toBe(true)
  })

  it('rejects a tampered payload', () => {
    expect(verifyJiraWebhook({ payload: `${payload} `, signature: sign(payload), secret })).toBe(
      false,
    )
  })

  it('rejects a wrong secret', () => {
    expect(verifyJiraWebhook({ payload, signature: sign(payload), secret: 'other' })).toBe(false)
  })

  it('normalizes a webhook into a stable envelope', () => {
    const env = normalizeJiraWebhook({
      webhookEvent: 'jira:issue_created',
      timestamp: 1718200000000,
      issue: { id: '10001' },
    })
    expect(env.source).toBe('jira')
    expect(env.type).toBe('jira:issue_created')
    expect(env.id).toBe('10001:1718200000000')
    expect(env.receivedAt).toBe(1718200000000)
  })

  it('derives an id when issue id is absent', () => {
    const env = normalizeJiraWebhook({ webhookEvent: 'jira:issue_updated' })
    expect(env.id).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// Poll JQL builder
// ---------------------------------------------------------------------------

describe('buildPollJql', () => {
  it('floors the watermark to minute granularity and orders ascending', () => {
    const jql = buildPollJql('PROJ', 1718200030000)
    expect(jql).toBe('project = "PROJ" AND updated >= 1718200020000 ORDER BY updated ASC')
  })
})

// ---------------------------------------------------------------------------
// Manifest: redaction proof + no secret values
// ---------------------------------------------------------------------------

describe('manifest', () => {
  it('declares credentials by reference only — no values anywhere', () => {
    const serialized = JSON.stringify(jiraManifest)
    expect(serialized).not.toContain('sekret-token-xyz')
    for (const schema of jiraManifest.credentials ?? []) {
      for (const field of schema.fields) {
        expect(field).not.toHaveProperty('value')
        expect(field).not.toHaveProperty('token')
      }
    }
  })

  it('audit redaction covers the API token and Authorization header', () => {
    const paths = jiraManifest.auditRedaction?.redactPaths ?? []
    expect(paths).toContain('credentials.apiToken')
    expect(paths.some((p) => p.toLowerCase() === 'headers.authorization')).toBe(true)
  })

  it('every action requires network and the webhook is hmac-verified', () => {
    for (const action of jiraManifest.actions ?? []) {
      expect(action.requiredPermissions).toContain('network')
    }
    expect(jiraManifest.webhooks?.[0]?.verification).toBe('hmac')
  })

  it('the live test is gated on SKELM_LIVE_JIRA', () => {
    expect(jiraManifest.liveTests?.[0]?.requiredEnv).toContain('SKELM_LIVE_JIRA')
  })
})

// ---------------------------------------------------------------------------
// Live test (opt-in; skips cleanly without env)
// ---------------------------------------------------------------------------

const live = jiraManifest.liveTests?.[0]
const runLive = live?.requiredEnv.every((n) => (process.env[n] ?? '').length > 0) ?? false

describe.skipIf(!runLive)('live Jira smoke', () => {
  it('GET /myself authenticates against the real site', async () => {
    const c = new JiraClient({
      baseUrl: process.env.JIRA_BASE_URL as string,
      credentials: {
        email: process.env.JIRA_EMAIL as string,
        apiToken: process.env.JIRA_API_TOKEN as string,
      },
      egress: ALLOW_ALL,
    })
    const me = await getMyself(c)
    expect(typeof me.accountId).toBe('string')
  })
})
