# @skelm/integration-google-sheets

Typed actions over the [Google Sheets v4 REST API](https://developers.google.com/sheets/api/reference/rest)
built on `@skelm/integration-sdk` primitives — egress-gated `httpRequest`,
exponential-backoff retry, and cursor pagination.

## Security model

Authentication is an **OAuth2 access token resolved by the gateway** from a
`CredentialReference`. This package:

- never runs an OAuth dance and never reads `process.env`,
- receives an already-resolved access token at dispatch and uses it only to
  build a single `Authorization: Bearer` header,
- never logs, stores, or returns the token, and redacts any token-shaped string
  from errors and health-check detail (`redactBearer`),
- refuses any request to a host the gateway-supplied `EgressPolicy` denies.

## Actions

| Action | Sheets endpoint |
| --- | --- |
| `readRange` | `spreadsheets.values.get` |
| `readRanges` | `spreadsheets.values:batchGet` |
| `appendRows` | `spreadsheets.values.append` |
| `updateRange` | `spreadsheets.values.update` |
| `clearRange` | `spreadsheets.values.clear` |
| `getSpreadsheetMetadata` | `spreadsheets.get` (fields-masked) |
| `readRowsPaginated` | row-windowed `values.get` via `paginate` |

All actions require the `network` permission and take a `SheetsRequestContext`
(spreadsheet id, resolved access token, egress hook, optional injected fetch and
retry).

## Trigger

`pollNewRows` is a pure polling step. Its cursor is the row count observed on
the previous poll; the first poll establishes the baseline and emits no rows, so
a fresh trigger does not replay history. Durable cursor storage and scheduling
are the gateway's responsibility.

## Usage

```ts
import {
  buildSheetsContext,
  googleSheetsTokenReference,
  readRange,
} from '@skelm/integration-google-sheets'

// `resolvedAccessToken` and `egress` are supplied by the gateway at dispatch.
const ctx = buildSheetsContext({
  spreadsheetId,
  tokenReference: googleSheetsTokenReference('GOOGLE_SHEETS_ACCESS_TOKEN'),
  resolvedAccessToken,
  egress,
})

const { values } = await readRange(ctx, { range: 'Sheet1!A1:C10' })
```

## Health check

`checkSheetsHealth(ctx)` performs a cheap, fields-masked `spreadsheets.get` and
returns a `ProviderHealthCheck` with no secret values in `detail`.

## Manifest

`googleSheetsManifest` is the `IntegrationPackageManifest` the gateway reads to
register actions/trigger, the credential schema, dashboard setup, a
`MockProviderFixture`, an `SKELM_LIVE_GOOGLE_SHEETS`-gated `LiveTestDescriptor`,
and the audit redaction policy covering the bearer token.

## Live test

The live test runs only when `SKELM_LIVE_GOOGLE_SHEETS`,
`GOOGLE_SHEETS_ACCESS_TOKEN`, and `GOOGLE_SHEETS_SPREADSHEET_ID` are all set;
otherwise it is skipped (never failed).
