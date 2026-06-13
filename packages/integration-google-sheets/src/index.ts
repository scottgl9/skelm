/**
 * @skelm/integration-google-sheets
 *
 * Typed actions over the Google Sheets v4 REST API built on
 * `@skelm/integration-sdk` primitives: egress-gated `httpRequest`, retry/backoff,
 * and pagination. Auth is an OAuth2 access token resolved by the gateway from a
 * `CredentialReference` — this package runs no OAuth dance and never reads
 * `process.env` or persists/logs the token.
 */

export {
  SHEETS_API_BASE,
  SHEETS_API_HOST,
  SheetsApiError,
  isRetryableSheetsError,
  redactBearer,
  sheetsRequest,
} from './client.js'
export type { SheetsRequestContext } from './client.js'

export {
  appendRows,
  clearRange,
  getSpreadsheetMetadata,
  readRange,
  readRanges,
  readRowsPaginated,
  updateRange,
} from './actions.js'
export type {
  AppendRowsInput,
  AppendRowsResult,
  CellValue,
  ClearRangeInput,
  ClearRangeResult,
  InsertDataOption,
  ReadRangeInput,
  ReadRangeResult,
  ReadRangesInput,
  SheetMetadata,
  SheetRow,
  SpreadsheetMetadata,
  UpdateRangeInput,
  UpdateRangeResult,
  ValueInputOption,
  ValueRenderOption,
} from './actions.js'

export { pollNewRows } from './trigger.js'
export type { NewRowsPollInput, NewRowsPollResult } from './trigger.js'

export {
  GOOGLE_SHEETS_PROVIDER,
  buildSheetsContext,
  checkSheetsHealth,
  googleSheetsCredentialSchema,
  googleSheetsManifest,
  googleSheetsTokenReference,
} from './manifest.js'
