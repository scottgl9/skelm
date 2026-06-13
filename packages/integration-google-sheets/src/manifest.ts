/**
 * Declarative manifest for the Google Sheets integration plus credential
 * assembly and health check.
 *
 * The package declares one credential set — an OAuth2 access token referenced
 * by `secretName`. The gateway owns the OAuth refresh/resolution dance and
 * hands this package an already-resolved access token at dispatch; the package
 * never reads `process.env` and never persists the token.
 */

import {
  type CredentialReference,
  type CredentialSchema,
  type IntegrationPackageManifest,
  type LiveTestDescriptor,
  type MockProviderFixture,
  type ProviderHealthCheck,
  assertNoSecretValue,
  isCredentialReference,
} from '@skelm/integration-sdk'
import { getSpreadsheetMetadata } from './actions.js'
import type { SheetsRequestContext } from './client.js'
import { SheetsApiError, redactBearer } from './client.js'

export const GOOGLE_SHEETS_PROVIDER = 'google-sheets'

/** The single secret this integration needs: an OAuth2 access token. */
export const googleSheetsCredentialSchema: CredentialSchema = {
  id: 'google-sheets',
  description: 'OAuth2 access token with the Google Sheets API scope.',
  fields: [
    {
      name: 'accessToken',
      kind: 'token',
      description:
        'Gateway-resolved OAuth2 access token (Bearer). The gateway owns refresh; this package receives a resolved value.',
    },
  ],
}

/** A reference to the OAuth access-token secret by name (never a value). */
export function googleSheetsTokenReference(secretName: string): CredentialReference {
  return { kind: 'credential-ref', secretName, field: 'accessToken' }
}

/**
 * Assemble a request context from a gateway-resolved access token. Validates at
 * the boundary that no value was smuggled in place of a reference and that the
 * reference is well-formed. The resolved token is held only on the returned
 * context for the duration of the call.
 */
export function buildSheetsContext(args: {
  readonly spreadsheetId: string
  readonly tokenReference: CredentialReference
  readonly resolvedAccessToken: string
  readonly egress: SheetsRequestContext['egress']
  readonly fetchImpl?: SheetsRequestContext['fetchImpl']
  readonly retry?: SheetsRequestContext['retry']
  readonly signal?: AbortSignal
}): SheetsRequestContext {
  assertNoSecretValue(args.tokenReference, 'google-sheets token reference')
  if (!isCredentialReference(args.tokenReference)) {
    throw new SheetsApiError('google-sheets requires a credential reference, not a value', 0)
  }
  return {
    spreadsheetId: args.spreadsheetId,
    accessToken: args.resolvedAccessToken,
    egress: args.egress,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.retry ? { retry: args.retry } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  }
}

/**
 * Cheap liveness/credential check: a metadata GET with a `fields` mask. Returns
 * a {@link ProviderHealthCheck} whose `detail` carries no secret value (the
 * bearer token is redacted from any error text).
 */
export async function checkSheetsHealth(ctx: SheetsRequestContext): Promise<ProviderHealthCheck> {
  const checkedAt = new Date().toISOString()
  try {
    const meta = await getSpreadsheetMetadata(ctx)
    return {
      healthy: true,
      status: 'ok',
      checkedAt,
      detail: `reachable: ${meta.sheets.length} sheet(s)`,
    }
  } catch (error) {
    const status = error instanceof SheetsApiError && error.status >= 400 ? 'unhealthy' : 'error'
    const message = error instanceof Error ? error.message : String(error)
    return { healthy: false, status, checkedAt, detail: redactBearer(message) }
  }
}

const mockFixture: MockProviderFixture = {
  provider: GOOGLE_SHEETS_PROVIDER,
  description: 'Canned Sheets v4 responses for deterministic CI.',
  payloads: {
    'values.get': {
      range: 'Sheet1!A1:C2',
      majorDimension: 'ROWS',
      values: [
        ['name', 'email', 'score'],
        ['ada', 'ada@example.com', 42],
      ],
    },
    'values.append': {
      updates: { updatedRange: 'Sheet1!A3:C3', updatedRows: 1, updatedCells: 3 },
    },
    'spreadsheets.get': {
      spreadsheetId: 'sheet-123',
      properties: { title: 'Demo' },
      sheets: [{ properties: { sheetId: 0, title: 'Sheet1', index: 0 } }],
    },
    'error.429': { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Rate limit' } },
  },
}

const liveTest: LiveTestDescriptor = {
  provider: GOOGLE_SHEETS_PROVIDER,
  name: 'Google Sheets read range (live)',
  requiredEnv: [
    'SKELM_LIVE_GOOGLE_SHEETS',
    'GOOGLE_SHEETS_ACCESS_TOKEN',
    'GOOGLE_SHEETS_SPREADSHEET_ID',
  ],
  description:
    'Reads a small range from a real spreadsheet using a resolved OAuth token. Skipped unless all env vars are set.',
}

export const googleSheetsManifest: IntegrationPackageManifest = {
  name: '@skelm/integration-google-sheets',
  version: '0.4.8',
  description: 'Typed Google Sheets v4 actions and a polling new-rows trigger.',
  actions: [
    {
      id: 'readRange',
      description: 'Read a single A1 range (values.get).',
      requiredPermissions: ['network'],
    },
    {
      id: 'readRanges',
      description: 'Read multiple ranges (values:batchGet).',
      requiredPermissions: ['network'],
    },
    {
      id: 'appendRows',
      description: 'Append rows to a table (values.append).',
      requiredPermissions: ['network'],
    },
    {
      id: 'updateRange',
      description: 'Overwrite a range (values.update).',
      requiredPermissions: ['network'],
    },
    {
      id: 'clearRange',
      description: 'Clear a range (values.clear).',
      requiredPermissions: ['network'],
    },
    {
      id: 'getSpreadsheetMetadata',
      description: 'Fetch spreadsheet/sheet metadata (spreadsheets.get).',
      requiredPermissions: ['network'],
    },
  ],
  triggers: [
    {
      id: 'newRows',
      kind: 'poll',
      description: 'Emit rows appended to a sheet since the last poll (cursor = row count).',
      events: ['rows.appended'],
    },
  ],
  credentials: [googleSheetsCredentialSchema],
  requiredPermissions: ['network'],
  supportedEvents: ['rows.appended'],
  dashboard: {
    title: 'Google Sheets',
    fields: {
      spreadsheetId: { label: 'Spreadsheet ID', kind: 'string', required: true },
      accessToken: { label: 'OAuth2 access token secret', kind: 'secret-ref', required: true },
    },
  },
  mockFixtures: [mockFixture],
  liveTests: [liveTest],
  auditRedaction: {
    redactPaths: ['accessToken', 'resolvedAccessToken', 'headers.authorization', 'authorization'],
  },
}
