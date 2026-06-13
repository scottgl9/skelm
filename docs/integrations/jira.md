---
title: Jira Integration
---

# Jira Integration

`@skelm/integration-jira` connects skelm pipelines to **Jira Cloud** over the
REST v3 API, built on the [integration primitives](/reference/integration-primitives).
It exposes typed issue actions, paginated JQL search, and issue triggers, and
authenticates with HTTP Basic (Atlassian account email + API token).

It follows the SDK security model: credentials are **gateway-resolved
references**, every request goes through the egress-gated `httpRequest` helper,
and the API token never appears in logs, audit rows, or error messages.

## Install

```bash
npm install @skelm/integration-jira
```

## Credentials

A Jira connection declares two secret fields by name — never values:

| Field | Kind | Use |
| --- | --- | --- |
| `email` | `string` | Atlassian account email — the Basic-auth user. |
| `apiToken` | `token` | Atlassian API token — the Basic-auth password. |

Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
The gateway resolves these references to ephemeral values at dispatch and hands
them to the `JiraClient`; the assembled `Authorization: Basic` header is built
per request and is never logged.

## Actions

| Function | REST call | Result |
| --- | --- | --- |
| `createIssue` | `POST /issue` | `{ id, key, self }` |
| `getIssue` | `GET /issue/{idOrKey}` | full issue |
| `updateIssue` | `PUT /issue/{idOrKey}` | — |
| `transitionIssue` | `POST /issue/{idOrKey}/transitions` | — |
| `addComment` | `POST /issue/{idOrKey}/comment` | `{ id, self }` |
| `searchIssues` / `searchIssuesAll` | `POST /search/jql` | issues (paginated) |
| `getMyself` / `checkJiraHealth` | `GET /myself` | identity / health |

String `description` and comment bodies are wrapped into Atlassian Document
Format (ADF) automatically; pass a pre-built `AdfDocument` for rich content.

```ts
import { JiraClient, createIssue, searchIssuesAll } from '@skelm/integration-jira'

const jira = new JiraClient({
  baseUrl: 'https://your-domain.atlassian.net',
  credentials: { email, apiToken }, // resolved by the gateway
  egress,                            // gateway network policy hook
  rateLimit: { requests: 50, windowMs: 1000 },
})

await createIssue(jira, { projectKey: 'ENG', issueType: 'Bug', summary: 'Crash on startup' })

// JQL search paginates the nextPageToken cursor to exhaustion.
const open = await searchIssuesAll(jira, { jql: 'project = ENG AND statusCategory != Done' })
```

## Retry, rate limiting, and egress

- **Egress.** Every call routes through the SDK `httpRequest`, which consults
  the required `EgressPolicy`. A denied host throws before any network I/O — the
  integration cannot bypass gateway network policy.
- **Retry.** `429` and `5xx` responses (and network errors) are classified
  retryable and retried with exponential backoff via `withRetry`; `4xx` caller
  errors are not retried. `Retry-After` is parsed onto `JiraApiError`.
- **Rate limiting.** An optional client-side `RateLimiter` (sliding window)
  short-circuits with a synthetic `429` when the local budget is exhausted.

## Triggers

### Webhook (`/webhooks/jira`)

Jira Cloud's REST-registered dynamic webhooks are **not HMAC-signed by default**,
so signature verification is only meaningful when a reverse proxy or Atlassian
automation attaches a shared secret. When one is configured, verify before
normalizing:

```ts
import { verifyJiraWebhook, normalizeJiraWebhook } from '@skelm/integration-jira'

if (!verifyJiraWebhook({ payload: rawBody, signature, secret })) return // reject
const event = normalizeJiraWebhook(JSON.parse(rawBody))
```

The webhook emits `jira:issue_created`, `jira:issue_updated`, and
`jira:issue_deleted`.

### Polling (reliable default)

When no signing secret is available, poll instead. `buildPollJql` returns issues
updated since a watermark, ordered ascending, so you can advance a cursor:

```ts
import { buildPollJql, searchIssuesAll, IdempotencyTracker } from '@skelm/integration-jira'
// ...
const jql = buildPollJql('ENG', lastWatermarkMs)
const updated = await searchIssuesAll(jira, { jql })
```

The `updated` JQL clause has **minute granularity**, so overlap the window and
dedupe with the SDK `IdempotencyTracker` rather than assuming exact-millisecond
cursors.

## Health check

`checkJiraHealth(client)` calls `GET /myself` and returns a `ProviderHealthCheck`
(`ok` / `unhealthy` on `401`/`403` / `error`). The `detail` field carries only
the account identity or a status string — never a secret.

## Audit redaction

The integration manifest declares an `auditRedaction` policy redacting
`credentials.apiToken` and the `Authorization` header from audit, logs, and
errors. Secret values are always redacted regardless; this names the additional
sensitive fields.

## Live tests

The opt-in live smoke test runs only when `SKELM_LIVE_JIRA`, `JIRA_BASE_URL`,
`JIRA_EMAIL`, and `JIRA_API_TOKEN` are all present; otherwise it skips. It calls
only `GET /myself` and creates nothing.
