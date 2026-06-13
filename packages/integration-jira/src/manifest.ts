/**
 * The {@link IntegrationPackageManifest} for `@skelm/integration-jira`: the
 * runtime descriptor the gateway reads to register actions/triggers, render the
 * dashboard connection wizard, run mock + live tests, and apply audit
 * redaction. Credentials appear by schema/reference only — never values.
 */

import type {
  CredentialSchema,
  IntegrationPackageManifest,
  LiveTestDescriptor,
  MockProviderFixture,
} from '@skelm/integration-sdk'
import { JIRA_ISSUE_EVENTS, JIRA_SOURCE } from './webhook.js'

/** Secrets a Jira connection requires. Basic auth: account email + API token. */
export const jiraCredentialSchema: CredentialSchema = {
  id: 'jira',
  description: 'Jira Cloud Basic-auth credentials (account email + API token).',
  fields: [
    { name: 'email', kind: 'string', description: 'Atlassian account email (Basic-auth user).' },
    { name: 'apiToken', kind: 'token', description: 'Atlassian API token (Basic-auth password).' },
  ],
}

const jiraMockFixture: MockProviderFixture = {
  provider: JIRA_SOURCE,
  description: 'Canned Jira REST responses and an issue-created webhook payload.',
  payloads: {
    myself: { accountId: 'acct-123', displayName: 'Mock Bot', emailAddress: 'bot@example.com' },
    createdIssue: {
      id: '10001',
      key: 'TEST-1',
      self: 'https://x.atlassian.net/rest/api/3/issue/10001',
    },
    issue: {
      id: '10001',
      key: 'TEST-1',
      self: 'https://x.atlassian.net/rest/api/3/issue/10001',
      fields: { summary: 'Mock issue', status: { name: 'To Do' } },
    },
    searchPage1: {
      issues: [{ id: '10001', key: 'TEST-1', self: 's1', fields: {} }],
      nextPageToken: 'cursor-2',
    },
    searchPage2: {
      issues: [{ id: '10002', key: 'TEST-2', self: 's2', fields: {} }],
    },
    issueCreatedWebhook: {
      webhookEvent: 'jira:issue_created',
      timestamp: 1718200000000,
      issue: { id: '10001', key: 'TEST-1', self: 'https://x.atlassian.net/rest/api/3/issue/10001' },
    },
  },
}

const jiraLiveTest: LiveTestDescriptor = {
  provider: JIRA_SOURCE,
  name: 'Jira Cloud live smoke (GET /myself)',
  requiredEnv: ['SKELM_LIVE_JIRA', 'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],
  description:
    'When set, calls GET /myself against the live site to verify Basic auth. Reads no other state and creates nothing.',
}

/** The integration manifest exported as the package default + named export. */
export const jiraManifest: IntegrationPackageManifest = {
  name: '@skelm/integration-jira',
  version: '0.4.8',
  description: 'Jira Cloud issue actions, JQL search, and issue triggers.',
  actions: [
    { id: 'jira.createIssue', description: 'Create an issue.', requiredPermissions: ['network'] },
    { id: 'jira.getIssue', description: 'Fetch a single issue.', requiredPermissions: ['network'] },
    {
      id: 'jira.updateIssue',
      description: 'Update issue fields.',
      requiredPermissions: ['network'],
    },
    {
      id: 'jira.transitionIssue',
      description: 'Move an issue through a workflow transition.',
      requiredPermissions: ['network'],
    },
    {
      id: 'jira.addComment',
      description: 'Add a comment to an issue.',
      requiredPermissions: ['network'],
    },
    {
      id: 'jira.searchIssues',
      description: 'Run a paginated JQL search.',
      requiredPermissions: ['network'],
    },
  ],
  triggers: [
    {
      id: 'jira.issue-events',
      kind: 'webhook',
      description:
        'Issue created/updated/deleted. Verified by HMAC only when a proxy/automation attaches a shared secret; otherwise use the poll trigger.',
      events: [...JIRA_ISSUE_EVENTS],
    },
    {
      id: 'jira.issue-poll',
      kind: 'poll',
      description:
        'JQL-cursor polling on the `updated` field; the reliable default for Jira Cloud.',
      events: [...JIRA_ISSUE_EVENTS],
    },
  ],
  credentials: [jiraCredentialSchema],
  requiredPermissions: ['network'],
  webhooks: [
    {
      path: '/webhooks/jira',
      verification: 'hmac',
      events: [...JIRA_ISSUE_EVENTS],
    },
  ],
  supportedEvents: [...JIRA_ISSUE_EVENTS],
  dashboard: {
    title: 'Connect Jira Cloud',
    fields: {
      baseUrl: {
        label: 'Site URL',
        placeholder: 'https://your-domain.atlassian.net',
        required: true,
      },
      email: { label: 'Account email', required: true, secret: false },
      apiToken: { label: 'API token', required: true, secret: true },
    },
  },
  mockFixtures: [jiraMockFixture],
  liveTests: [jiraLiveTest],
  auditRedaction: {
    redactPaths: ['credentials.apiToken', 'headers.Authorization', 'headers.authorization'],
  },
}
