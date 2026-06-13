# @skelm/integration-notion

Typed [Notion API](https://developers.notion.com/) actions for skelm, built on
`@skelm/integration-sdk` primitives.

Every request goes through the SDK's egress-gated `httpRequest`, sends the
required `Notion-Version` header, and authenticates with a **gateway-resolved
integration token**. The package never reads the token from `process.env`,
never holds it beyond a single dispatch, and never logs it.

---

## Installation

```bash
pnpm add @skelm/integration-notion
```

---

## Actions

| Action                         | Method / path                              | Notes                                  |
| ------------------------------ | ------------------------------------------ | -------------------------------------- |
| `queryDatabase`                | `POST /v1/databases/{id}/query`            | Paginates to exhaustion over cursors   |
| `createPage`                   | `POST /v1/pages`                           | Parent + properties (+ children)       |
| `updatePage`                   | `PATCH /v1/pages/{id}`                      | Properties, archive, icon/cover        |
| `getPage`                      | `GET /v1/pages/{id}`                        | Single page                            |
| `appendBlockChildren`          | `PATCH /v1/blocks/{id}/children`            | Returns created child blocks           |
| `search`                       | `POST /v1/search`                           | Paginates to exhaustion over cursors   |

---

## Usage

The gateway resolves the integration token from a `CredentialReference` and
hands the ephemeral value to the client for one dispatch, along with the
required `EgressPolicy`:

```ts
import {
  createNotionClient,
  queryDatabase,
} from '@skelm/integration-notion'

// `token` is the value the gateway resolved from a CredentialReference.
// `egress` is the gateway-supplied policy hook.
const notion = createNotionClient({ token }, { egress })

const pages = await queryDatabase(notion, {
  databaseId: 'd9824bdc-8445-4327-be8b-5b47500af6ce',
  filter: { property: 'Status', select: { equals: 'Done' } },
})
```

The client refuses any host the egress policy denies, sends `Notion-Version` on
every request, and retries `429`/`5xx` with exponential backoff via the SDK's
`withRetry`.

---

## Credentials

The package declares one credential — an internal integration token — **by
reference only**:

```ts
import { NOTION_CREDENTIAL_SCHEMA } from '@skelm/integration-notion'
// { id: 'notion', fields: [{ name: 'integrationToken', kind: 'token' }] }
```

Create an internal integration at
[notion.so/my-integrations](https://www.notion.com/my-integrations), then share
the target pages/databases with it.

---

## Health, fixtures, live tests

- `checkHealth(client)` calls `GET /v1/users/me` and returns a
  `ProviderHealthCheck` whose `detail` carries only the bot name — never the
  token.
- `NOTION_MOCK_FIXTURE` ships canned payloads for deterministic CI.
- `NOTION_LIVE_TEST` is opt-in, gated on `SKELM_LIVE_NOTION` and
  `SKELM_LIVE_NOTION_TOKEN`; default CI skips it cleanly.

---

## Security

- Credentials are references; the gateway resolves and redacts them.
- `NOTION_AUDIT_REDACTION` redacts the `Authorization` header and the
  `integrationToken` field from audit rows, logs, and errors.
- The package takes no privileged action outside the SDK's egress-gated
  `httpRequest`.

See [the integration docs](https://skelm.dev/integrations/notion) for details.
