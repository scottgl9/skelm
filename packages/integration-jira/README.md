# @skelm/integration-jira

> Jira Cloud integration for [skelm](https://github.com/scottgl9/skelm) — typed issue actions, paginated JQL search, and issue triggers, built on the `@skelm/integration-sdk` primitives.

[![npm](https://img.shields.io/npm/v/@skelm/integration-jira)](https://www.npmjs.com/package/@skelm/integration-jira)

Part of [skelm](https://github.com/scottgl9/skelm).

This package talks to the Jira Cloud REST v3 API over the SDK's egress-gated
`httpRequest`, with `withRetry`/`RateLimiter` for transient failures and rate
limits, and `paginate` for JQL search. Authentication is HTTP Basic (account
email + API token). **Credentials are gateway-resolved references** — this
package never reads `process.env` for secrets and never logs the API token.

## Install

```bash
npm install @skelm/integration-jira
```

## Actions

| Function | Jira REST call |
| --- | --- |
| `createIssue` | `POST /issue` |
| `getIssue` | `GET /issue/{idOrKey}` |
| `updateIssue` | `PUT /issue/{idOrKey}` |
| `transitionIssue` | `POST /issue/{idOrKey}/transitions` |
| `addComment` | `POST /issue/{idOrKey}/comment` |
| `searchIssues` / `searchIssuesAll` | `POST /search/jql` (cursor-paginated) |
| `getMyself` / `checkJiraHealth` | `GET /myself` |

Plain-text `description`/comment bodies are wrapped into Atlassian Document
Format (ADF); pass a pre-built `AdfDocument` for rich content.

## Quick Start

```ts
import { JiraClient, createIssue, searchIssuesAll } from '@skelm/integration-jira'

// `credentials` are the values the gateway resolved from CredentialReferences.
// `egress` is the gateway-supplied network policy hook.
const jira = new JiraClient({
  baseUrl: 'https://your-domain.atlassian.net',
  credentials: { email, apiToken },
  egress,
})

const issue = await createIssue(jira, {
  projectKey: 'ENG',
  issueType: 'Task',
  summary: 'Investigate flaky test',
  description: 'Seen on CI run #1234.',
})

for await (const found of /* searchIssues(jira, { jql }) */ []) {
  // stream JQL results, paginated to exhaustion
}
const all = await searchIssuesAll(jira, { jql: 'project = ENG AND statusCategory != Done' })
```

## Triggers

- **Webhook** (`/webhooks/jira`): Jira Cloud's REST-registered dynamic webhooks
  are not HMAC-signed by default, so verification is only available when a proxy
  or Atlassian automation attaches a shared secret. When it does, call
  `verifyJiraWebhook(...)` (constant-time HMAC-SHA256) **before**
  `normalizeJiraWebhook(...)`.
- **Polling** (the reliable default): use `buildPollJql(projectKey, sinceMs)` to
  query issues updated since a watermark, ordered ascending, and dedupe with the
  SDK `IdempotencyTracker` (the `updated` clause has minute granularity).

## Credentials & security

The package declares a `jira` credential schema with `email` and `apiToken`
fields (by name only). The gateway resolves them per dispatch; the assembled
`Authorization: Basic` header is built per-request and never logged. The
manifest's `auditRedaction` redacts `credentials.apiToken` and the
`Authorization` header from audit, logs, and errors.

## Live tests

The opt-in live smoke test runs only when `SKELM_LIVE_JIRA`, `JIRA_BASE_URL`,
`JIRA_EMAIL`, and `JIRA_API_TOKEN` are all set; otherwise it skips cleanly. It
only calls `GET /myself` and creates nothing.

See the [Jira integration guide](https://skelm.dev/integrations/jira) for full
details.
