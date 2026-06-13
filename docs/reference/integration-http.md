---
title: '@skelm/integration-http'
---

# @skelm/integration-http

Generic authenticated HTTP request integration. Provides egress-gated,
credential-ref-safe HTTP actions built on `@skelm/integration-sdk` — with
optional retry/backoff, rate limiting, cursor-based pagination, and a provider
health check.

---

## Credential references and egress

Two invariants hold throughout this package:

**Credentials are references, never values.** The gateway resolves a
`CredentialReference` to an ephemeral string at dispatch. Your pipeline
receives the resolved string and assembles the header:

```ts
import { request } from '@skelm/integration-http'

// resolvedToken is a string the gateway already resolved — not a CredentialReference
const result = await request({
  method: 'GET',
  url: 'https://api.example.com/items',
  headers: { Authorization: `Bearer ${resolvedToken}` },
  egress, // supplied by the gateway dispatcher
})
```

**Every action requires an `EgressPolicy`.** The gateway supplies this hook
when it dispatches your step. If the policy denies the target host,
`IntegrationSdkError` is thrown before any network call is made.

---

## Actions

### `request(input)` — generic HTTP request

The base action. Accepts any method, optional headers, query parameters, and
a string body.

```ts
import { request } from '@skelm/integration-http'

const result = await request({
  method: 'POST',
  url: 'https://api.example.com/messages',
  headers: {
    Authorization: `Bearer ${resolvedToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ text: 'hello' }),
  egress,
})
// result: { status: number, headers: Record<string, string>, body: unknown }
```

### `get(url, opts)` — convenience GET

```ts
import { get } from '@skelm/integration-http'

const result = await get('https://api.example.com/items', {
  egress,
  headers: { Authorization: `Bearer ${resolvedToken}` },
  query: { page: '2' },
})
```

### `post(url, body, opts)` — convenience POST (JSON)

Serializes `body` as JSON and sets `content-type: application/json`
automatically.

```ts
import { post } from '@skelm/integration-http'

const result = await post(
  'https://api.example.com/items',
  { name: 'widget' },
  { egress, headers: { Authorization: `Bearer ${resolvedToken}` } },
)
```

### `paginateAll(input)` — cursor-based pagination

Drives pagination to exhaustion and returns a flat array of all items. Supply
`getNextCursor` and `getItems` to adapt any response shape:

```ts
import { paginateAll } from '@skelm/integration-http'

const items = await paginateAll({
  url: 'https://api.example.com/list',
  egress,
  headers: { Authorization: `Bearer ${resolvedToken}` },
  getNextCursor: (body) => (body as { next?: string }).next,
  getItems: (body) => (body as { data: unknown[] }).data,
  maxPages: 50,
})
```

The current cursor is appended as a `cursor` query parameter on each subsequent
page request.

---

## Retry and rate limiting

Both are optional and composable:

```ts
import { request } from '@skelm/integration-http'
import { RateLimiter } from '@skelm/integration-sdk'

const limiter = new RateLimiter(10, 1_000) // 10 req / 1 s window

const result = await request({
  method: 'GET',
  url: 'https://api.example.com/items',
  egress,
  rateLimiter: limiter,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 5_000,
  },
})
```

5xx responses and network errors are retried with exponential backoff. 4xx
responses are not retried — they throw `HttpClientError` immediately.

---

## Health check

```ts
import { checkHealth } from '@skelm/integration-http'

const health = await checkHealth({
  baseUrl: 'https://api.example.com',
  egress,
  method: 'HEAD', // default; use 'GET' for APIs that reject HEAD
})
// { healthy: boolean, status: 'ok' | 'unhealthy' | 'error', checkedAt: string, detail?: string }
```

`detail` contains only `METHOD host → status` — never a secret value.

---

## Audit redaction

`Authorization`, `X-Api-Key`, `X-Auth-Token`, `Proxy-Authorization`,
`Cookie`, and `Set-Cookie` headers are always replaced with `[REDACTED]`
before any log or audit record is produced. Use `auditDescriptor()` to build
safe log objects:

```ts
import { auditDescriptor } from '@skelm/integration-http'

const desc = auditDescriptor('GET', url, result.status, result.headers)
// { method: 'GET', host: 'api.example.com', status: 200, headers: { Authorization: '[REDACTED]', ... } }
```

Query parameters are also stripped from URLs that appear in error messages —
only `scheme://host/path` is logged.

---

## Manifest

Register the gateway manifest to expose the four action definitions:

```ts
import { manifest } from '@skelm/integration-http'
// manifest.actions: http.request, http.get, http.post, http.paginate
// manifest.requiredPermissions: ['egress']
// manifest.auditRedaction: { redactPaths: [...] }
```

---

## Error types

| Class | When |
| --- | --- |
| `HttpEgressDeniedError` | Egress policy denied the host — no network call made |
| `HttpClientError` | 4xx response (non-retryable); carries `.statusCode` |
| `HttpServerError` | 5xx after all retries; carries `.statusCode` |
| `HttpNetworkError` | DNS / connection / timeout failure; carries `.networkCause` |

All extend `HttpIntegrationError` → `IntegrationSdkError`.

---

## See also

- [Integration Primitives](./integration-primitives.md) — SDK credential model,
  `EgressPolicy`, helpers this package builds on
