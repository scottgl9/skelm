/**
 * Notion integration manifest: credential schema (by reference only), health
 * check, dashboard setup, mock fixture, env-gated live test, and audit
 * redaction covering the integration token.
 */

import type {
  AuditRedactionPolicy,
  CredentialSchema,
  DashboardSetupMetadata,
  IntegrationPackageManifest,
  LiveTestDescriptor,
  MockProviderFixture,
  ProviderHealthCheck,
} from '@skelm/integration-sdk'
import { NOTION_ACTIONS } from './actions.js'
import type { NotionClient } from './client.js'
import { getCurrentUser } from './health.js'

/** The integration's stable id, used across credentials/health/manifest. */
export const NOTION_INTEGRATION_ID = 'notion'

/**
 * Credentials Notion needs: one integration token, by name only. The gateway
 * resolves the named secret to an ephemeral value at dispatch — this schema
 * never carries the token itself.
 */
export const NOTION_CREDENTIAL_SCHEMA: CredentialSchema = {
  id: NOTION_INTEGRATION_ID,
  description: 'Notion internal integration token (Bearer).',
  fields: [
    {
      name: 'integrationToken',
      kind: 'token',
      description: 'Notion internal integration token, sent as a Bearer credential.',
    },
  ],
}

/**
 * Audit redaction policy. Secret values are always redacted by the gateway;
 * this additionally names the bearer header and credential field so the token
 * never reaches audit rows, logs, or error messages even if surfaced in a
 * structured request record.
 */
export const NOTION_AUDIT_REDACTION: AuditRedactionPolicy = {
  redactPaths: ['headers.authorization', 'headers.Authorization', 'credentials.integrationToken'],
}

export const NOTION_DASHBOARD: DashboardSetupMetadata = {
  title: 'Notion',
  fields: {
    integrationToken: {
      label: 'Integration token',
      kind: 'token',
      help: 'Create an internal integration at notion.so/my-integrations and paste its token. Share the target pages/databases with the integration.',
    },
  },
}

/**
 * Deterministic mock fixture for CI: canned Notion API payloads the unit suite
 * drives without real credentials.
 */
export const NOTION_MOCK_FIXTURE: MockProviderFixture = {
  provider: NOTION_INTEGRATION_ID,
  description: 'Canned Notion API responses for deterministic tests.',
  payloads: {
    'users.me': {
      object: 'user',
      id: '00000000-0000-0000-0000-000000000001',
      name: 'skelm bot',
      type: 'bot',
    },
    'databases.query.page1': {
      object: 'list',
      results: [{ object: 'page', id: 'page-1', properties: {} }],
      next_cursor: 'cursor-2',
      has_more: true,
    },
    'databases.query.page2': {
      object: 'list',
      results: [{ object: 'page', id: 'page-2', properties: {} }],
      next_cursor: null,
      has_more: false,
    },
    'pages.create': {
      object: 'page',
      id: 'page-created',
      url: 'https://www.notion.so/page-created',
      properties: {},
    },
    'error.unauthorized': {
      object: 'error',
      status: 401,
      code: 'unauthorized',
      message: 'API token is invalid.',
    },
    'error.rateLimited': {
      object: 'error',
      status: 429,
      code: 'rate_limited',
      message: 'Rate limited.',
    },
  },
}

/**
 * Opt-in live test, skipped unless `SKELM_LIVE_NOTION` and a token env var are
 * present. The descriptor only names env vars; it reads no secret values.
 */
export const NOTION_LIVE_TEST: LiveTestDescriptor = {
  provider: NOTION_INTEGRATION_ID,
  name: 'Notion live API',
  requiredEnv: ['SKELM_LIVE_NOTION', 'SKELM_LIVE_NOTION_TOKEN'],
  description: 'Exercises GET /v1/users/me against the live Notion API.',
}

/**
 * Health check: GET /v1/users/me. Returns a {@link ProviderHealthCheck} whose
 * `detail` carries only the bot name/status — never the token.
 */
export async function checkHealth(client: NotionClient): Promise<ProviderHealthCheck> {
  const checkedAt = new Date().toISOString()
  try {
    const user = await getCurrentUser(client)
    return {
      healthy: true,
      status: 'ok',
      checkedAt,
      detail: user.name ? `authenticated as ${user.name}` : 'authenticated',
    }
  } catch (error) {
    return {
      healthy: false,
      status: 'error',
      checkedAt,
      detail: error instanceof Error ? error.message : 'health check failed',
    }
  }
}

/** The declarative surface the gateway reads after loading this package. */
export const notionManifest: IntegrationPackageManifest = {
  name: '@skelm/integration-notion',
  version: '0.4.8',
  description: 'Typed Notion API integration under gateway-enforced egress.',
  actions: NOTION_ACTIONS,
  credentials: [NOTION_CREDENTIAL_SCHEMA],
  requiredPermissions: ['network'],
  dashboard: NOTION_DASHBOARD,
  mockFixtures: [NOTION_MOCK_FIXTURE],
  liveTests: [NOTION_LIVE_TEST],
  auditRedaction: NOTION_AUDIT_REDACTION,
}
