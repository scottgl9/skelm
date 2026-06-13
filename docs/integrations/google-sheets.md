# Google Sheets

`@skelm/integration-google-sheets` provides typed actions over the
[Google Sheets v4 REST API](https://developers.google.com/sheets/api/reference/rest),
built on the [integration primitives](../reference/integration-primitives.md):
the egress-gated `httpRequest` helper, exponential-backoff retry, and cursor
pagination.

## Trust posture

- **OAuth token by reference.** The package declares one credential — an OAuth2
  access token referenced by `secretName`. The **gateway owns the OAuth
  refresh/resolution dance** and hands the package an already-resolved access
  token at dispatch. The package never runs an OAuth flow, never reads
  `process.env`, and never persists the token.
- **Token never leaks.** The resolved token is used only to build a single
  `Authorization: Bearer` header for one request. It is never logged, stored, or
  returned. `redactBearer` scrubs any token-shaped string from error messages
  and the health-check `detail`, and the manifest's audit redaction policy
  covers `accessToken` and `headers.authorization`.
- **Egress enforced.** Every request consults the gateway-supplied
  `EgressPolicy`; a denied host fails before any network call.

## Actions

| Action | Endpoint | Notes |
| --- | --- | --- |
| `readRange` | `values.get` | Single A1 range; optional `valueRenderOption`. |
| `readRanges` | `values:batchGet` | Several ranges in one round-trip. |
| `appendRows` | `values.append` | `valueInputOption` defaults to `USER_ENTERED`. |
| `updateRange` | `values.update` | Overwrite a range. |
| `clearRange` | `values.clear` | Clear values in a range. |
| `getSpreadsheetMetadata` | `spreadsheets.get` | Fields-masked; doubles as the health check. |
| `readRowsPaginated` | windowed `values.get` | Yields rows page by page via `paginate`. |

Each action requires the `network` permission and takes a
`SheetsRequestContext`: the spreadsheet id, the gateway-resolved access token,
the egress hook, and optional injected `fetch`/retry for tests.

## Polling trigger

`pollNewRows` detects rows appended to a sheet since the previous poll. The
cursor is the total row count observed last time; the first poll establishes the
baseline and emits no rows, so a fresh trigger never replays history. Durable
cursor storage and scheduling stay with the gateway.

## Building a request context

```ts
import {
  buildSheetsContext,
  googleSheetsTokenReference,
  readRange,
} from '@skelm/integration-google-sheets'

// `resolvedAccessToken` and `egress` come from the gateway at dispatch.
const ctx = buildSheetsContext({
  spreadsheetId,
  tokenReference: googleSheetsTokenReference('GOOGLE_SHEETS_ACCESS_TOKEN'),
  resolvedAccessToken,
  egress,
})

const { values } = await readRange(ctx, { range: 'Sheet1!A1:C10' })
```

`buildSheetsContext` validates at the boundary that no secret value was smuggled
in place of the credential reference (`assertNoSecretValue`).

## Health check

`checkSheetsHealth(ctx)` runs a cheap, fields-masked `spreadsheets.get` and
returns a `ProviderHealthCheck`. The `detail` field carries no secret value.

## Testing

The package ships a `MockProviderFixture` with canned `values.get`,
`values.append`, `spreadsheets.get`, and `429` payloads for deterministic CI.
The `LiveTestDescriptor` is gated on `SKELM_LIVE_GOOGLE_SHEETS`,
`GOOGLE_SHEETS_ACCESS_TOKEN`, and `GOOGLE_SHEETS_SPREADSHEET_ID`; it is skipped
(never failed) when any are absent.
