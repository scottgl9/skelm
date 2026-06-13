import { assertNoSecretValue, shouldRunLiveTest } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'
import {
  NOTION_AUDIT_REDACTION,
  NOTION_CREDENTIAL_SCHEMA,
  NOTION_LIVE_TEST,
  NOTION_MOCK_FIXTURE,
  checkHealth,
  createNotionClient,
  getCurrentUser,
  notionManifest,
} from '../src/index.js'
import { allowAll, fakeFetch } from './helpers.js'

const TOKEN = 'secret_ntn_health_token'

describe('credential schema', () => {
  it('declares exactly the integration token, by reference only (no value)', () => {
    expect(NOTION_CREDENTIAL_SCHEMA.id).toBe('notion')
    expect(NOTION_CREDENTIAL_SCHEMA.fields.map((f) => f.name)).toEqual(['integrationToken'])
    expect(NOTION_CREDENTIAL_SCHEMA.fields[0]?.kind).toBe('token')
    // Schema carries no values: assertNoSecretValue passes on the field and a ref.
    assertNoSecretValue({ kind: 'credential-ref', secretName: 'NOTION_TOKEN' })
    expect(JSON.stringify(NOTION_CREDENTIAL_SCHEMA)).not.toContain(TOKEN)
  })
})

describe('audit redaction', () => {
  it('redacts the authorization header and the credential field', () => {
    expect(NOTION_AUDIT_REDACTION.redactPaths).toContain('headers.authorization')
    expect(NOTION_AUDIT_REDACTION.redactPaths).toContain('headers.Authorization')
    expect(NOTION_AUDIT_REDACTION.redactPaths).toContain('credentials.integrationToken')
  })
})

describe('manifest', () => {
  it('exposes actions, credentials, network permission, fixtures, and live tests', () => {
    expect(notionManifest.name).toBe('@skelm/integration-notion')
    expect(notionManifest.actions?.length).toBe(6)
    expect(notionManifest.credentials).toEqual([NOTION_CREDENTIAL_SCHEMA])
    expect(notionManifest.requiredPermissions).toContain('network')
    expect(notionManifest.mockFixtures).toEqual([NOTION_MOCK_FIXTURE])
    expect(notionManifest.liveTests).toEqual([NOTION_LIVE_TEST])
    expect(notionManifest.auditRedaction).toEqual(NOTION_AUDIT_REDACTION)
  })

  it('carries no secret value anywhere in the serialized manifest', () => {
    expect(JSON.stringify(notionManifest)).not.toContain(TOKEN)
  })
})

describe('mock fixture', () => {
  it('ships canned payloads for the documented scenarios', () => {
    expect(NOTION_MOCK_FIXTURE.provider).toBe('notion')
    expect(Object.keys(NOTION_MOCK_FIXTURE.payloads)).toEqual(
      expect.arrayContaining([
        'users.me',
        'databases.query.page1',
        'databases.query.page2',
        'pages.create',
        'error.unauthorized',
        'error.rateLimited',
      ]),
    )
  })
})

describe('live test gating', () => {
  it('requires SKELM_LIVE_NOTION and a token env var', () => {
    expect(NOTION_LIVE_TEST.requiredEnv).toContain('SKELM_LIVE_NOTION')
    expect(shouldRunLiveTest(NOTION_LIVE_TEST, {})).toBe(false)
    expect(shouldRunLiveTest(NOTION_LIVE_TEST, { SKELM_LIVE_NOTION: '1' })).toBe(false)
    expect(
      shouldRunLiveTest(NOTION_LIVE_TEST, {
        SKELM_LIVE_NOTION: '1',
        SKELM_LIVE_NOTION_TOKEN: 'tok',
      }),
    ).toBe(true)
  })
})

describe('getCurrentUser', () => {
  it('issues GET /v1/users/me and maps the user', async () => {
    const f = fakeFetch([{ body: { object: 'user', id: 'u1', name: 'bot', type: 'bot' } }])
    const client = createNotionClient(
      { token: TOKEN },
      { egress: allowAll, fetchImpl: f.fetchImpl },
    )
    const user = await getCurrentUser(client)
    expect(user.id).toBe('u1')
    expect(f.requestAt(0).url).toBe('https://api.notion.com/v1/users/me')
  })
})

describe('checkHealth', () => {
  it('reports healthy on a successful users/me and never leaks the token', async () => {
    const f = fakeFetch([{ body: { object: 'user', id: 'u1', name: 'skelm bot', type: 'bot' } }])
    const client = createNotionClient(
      { token: TOKEN },
      { egress: allowAll, fetchImpl: f.fetchImpl },
    )

    const health = await checkHealth(client)
    expect(health.healthy).toBe(true)
    expect(health.status).toBe('ok')
    expect(health.detail).toContain('skelm bot')
    expect(JSON.stringify(health)).not.toContain(TOKEN)
  })

  it('reports error on failure without exposing the token in detail', async () => {
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

    const health = await checkHealth(client)
    expect(health.healthy).toBe(false)
    expect(health.status).toBe('error')
    expect(health.detail ?? '').not.toContain(TOKEN)
  })
})
