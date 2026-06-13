# @skelm/integration-http

Generic authenticated HTTP request integration for skelm. Provides egress-gated,
credential-ref-safe HTTP actions with optional retry/backoff, rate limiting, and
cursor-based pagination — built on `@skelm/integration-sdk`.

## Installation

```sh
pnpm add @skelm/integration-http
```

## Credential references

Credentials are **never resolved** by this package. The gateway resolves a
`CredentialReference` to an ephemeral string at dispatch and passes it to your
pipeline as a concrete header value. You assemble the header and pass it in:

```ts
import { request } from '@skelm/integration-http'

// resolvedToken is a string already resolved by the gateway, not a CredentialReference
const result = await request({
  method: 'GET',
  url: 'https://api.example.com/items',
  headers: { Authorization: `Bearer ${resolvedToken}` },
  egress, // supplied by the gateway dispatcher
})
```

Never pass a `CredentialReference` object as a header value — pass only the
resolved string the gateway gives you.

## Egress requirement

Every action requires an `EgressPolicy` hook. The gateway supplies this when it
dispatches your pipeline step. Pass it through directly:

```ts
import { get } from '@skelm/integration-http'

// egress comes from your step's execution context, supplied by the gateway
const result = await get('https://api.example.com/data', { egress })
```

If the policy denies the target host, `IntegrationSdkError` is thrown **before
any network call** is made.

## Actions

### `request(input)` — generic HTTP request

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
const result = await get('https://api.example.com/items', { egress, headers })
```

### `post(url, body, opts)` — convenience POST (JSON)

```ts
import { post } from '@skelm/integration-http'
const result = await post('https://api.example.com/items', { name: 'x' }, { egress, headers })
```

### `paginateAll(input)` — cursor-based pagination

Collect all items across pages into a flat array. Supply `getNextCursor` and
`getItems` to adapt any response shape:

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

## Retry and rate limiting

```ts
import { request } from '@skelm/integration-http'
import { RateLimiter } from '@skelm/integration-sdk'

const limiter = new RateLimiter(10, 1000) // 10 req/s

const result = await request({
  method: 'GET',
  url: 'https://api.example.com/items',
  egress,
  rateLimiter: limiter,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 5000,
  },
})
```

5xx responses and network errors are retried; 4xx errors are not.

## Health check

```ts
import { checkHealth } from '@skelm/integration-http'

const health = await checkHealth({
  baseUrl: 'https://api.example.com',
  egress,
})
// health: { healthy: boolean, status: 'ok'|'unhealthy'|'error', checkedAt: string, detail?: string }
```

## Redaction

`Authorization`, `X-Api-Key`, `X-Auth-Token`, `Proxy-Authorization`, `Cookie`,
and `Set-Cookie` headers are **always redacted** (`[REDACTED]`) in any log
descriptor or audit output. Use `auditDescriptor()` to build safe log records:

```ts
import { auditDescriptor } from '@skelm/integration-http'

const desc = auditDescriptor('GET', url, result.status, result.headers)
// desc.headers.Authorization === '[REDACTED]'
// desc logs only: method, host, status
```

Query parameters are also stripped from URLs that appear in error messages —
only `scheme://host/path` is logged.

## Manifest

The package exports a ready-to-use `IntegrationPackageManifest`:

```ts
import { manifest } from '@skelm/integration-http'
```

Register it with the gateway to expose the `http.request`, `http.get`,
`http.post`, and `http.paginate` action definitions.

## Error types

| Class | When |
| --- | --- |
| `HttpEgressDeniedError` | Egress policy denied the host |
| `HttpClientError` | 4xx response (non-retryable); carries `statusCode` |
| `HttpServerError` | 5xx after all retries; carries `statusCode` |
| `HttpNetworkError` | DNS / connection / timeout failure |

All extend `HttpIntegrationError` → `IntegrationSdkError`.
