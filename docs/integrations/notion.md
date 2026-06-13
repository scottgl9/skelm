---
title: Notion
---

# Notion

`@skelm/integration-notion` provides typed actions over the
[Notion API](https://developers.notion.com/) (v1), built on the
[integration primitives](/reference/integration-primitives). It runs entirely
under gateway-enforced egress and never holds or logs the integration token.

## Install

```bash
pnpm add @skelm/integration-notion
```

## Authentication

Notion authenticates with an **internal integration token** sent as a Bearer
credential. The token is declared as a reference only — the gateway resolves the
named secret to an ephemeral value at dispatch and hands it to the client for
the duration of one call. The package never reads `process.env`, never persists
the token, and never writes it to logs, audit, or errors.

```ts
import { NOTION_CREDENTIAL_SCHEMA } from '@skelm/integration-notion'
// { id: 'notion', fields: [{ name: 'integrationToken', kind: 'token' }] }
```

Create an internal integration at
[notion.so/my-integrations](https://www.notion.com/my-integrations) and share
the pages/databases you want to reach with it.

## Actions

Each action is a typed function over a `NotionClient`. The client is created
from the gateway-resolved token plus the required `EgressPolicy`:

```ts
import { createNotionClient, queryDatabase } from '@skelm/integration-notion'

const notion = createNotionClient({ token }, { egress })

const pages = await queryDatabase(notion, {
  databaseId: 'd9824bdc-8445-4327-be8b-5b47500af6ce',
  filter: { property: 'Status', select: { equals: 'Done' } },
})
```

| Action                | API call                          | Description                              |
| --------------------- | --------------------------------- | ---------------------------------------- |
| `queryDatabase`       | `POST /v1/databases/{id}/query`   | Query a database, paginating to the end. |
| `createPage`          | `POST /v1/pages`                  | Create a page under a database or page.  |
| `updatePage`          | `PATCH /v1/pages/{id}`            | Update properties, archive, icon/cover.  |
| `getPage`             | `GET /v1/pages/{id}`              | Retrieve a single page.                  |
| `appendBlockChildren` | `PATCH /v1/blocks/{id}/children`  | Append child blocks; returns the blocks. |
| `search`              | `POST /v1/search`                 | Search pages/databases, paginating.      |

### Pagination

`queryDatabase` and `search` drive the SDK's `paginate` over Notion's
`next_cursor` / `has_more` envelope, fetching every page by default. Pass
`maxPages` to cap the number of requests, or `pageSize` (Notion caps at 100) to
control page size.

### Notion-Version header

Every request sends the required `Notion-Version` header (pinned to
`2022-06-28`). Requests with a JSON body also send `Content-Type:
application/json`.

### Retries and rate limits

Transient failures retry with exponential backoff via the SDK's `withRetry`:
HTTP `429` is classified as a retryable rate-limit error and `5xx` as a
retryable server error. `4xx` errors (auth, validation) surface immediately as a
typed `NotionApiError` carrying Notion's `code` and HTTP status — never the
token.

## Health checks

`checkHealth(client)` calls `GET /v1/users/me` and returns a
`ProviderHealthCheck`. Its `detail` reports only the authenticated bot name, so
no secret reaches the result.

## Testing

The package ships a `MockProviderFixture` (`NOTION_MOCK_FIXTURE`) with canned
API payloads for deterministic CI, and an opt-in `LiveTestDescriptor`
(`NOTION_LIVE_TEST`) gated on `SKELM_LIVE_NOTION` and `SKELM_LIVE_NOTION_TOKEN`.
Default CI skips the live test cleanly when those env vars are absent.

## Security

- Credentials are references; secret resolution and redaction are gateway-owned.
- `NOTION_AUDIT_REDACTION` redacts the `Authorization` header and the
  `integrationToken` field from audit rows, logs, and errors.
- All network access flows through the SDK's egress-gated `httpRequest`, which
  refuses any host the gateway's `EgressPolicy` denies.
