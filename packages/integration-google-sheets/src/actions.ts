/**
 * Typed actions over the Google Sheets v4 `values` and metadata endpoints.
 *
 * Each action shapes a request from typed inputs (A1 range, value-input option,
 * row body), executes it through {@link sheetsRequest} (egress-gated, bearer
 * auth, retry/classify), and maps the response to a typed result. No action
 * touches the access token beyond passing the context through.
 */

import { type Page, paginate } from '@skelm/integration-sdk'
import { type SheetsRequestContext, sheetsRequest } from './client.js'

/** A row of cell values, as the Sheets API represents them. */
export type CellValue = string | number | boolean | null
export type SheetRow = readonly CellValue[]

/** How input values are interpreted on write. */
export type ValueInputOption = 'RAW' | 'USER_ENTERED'
/** How values are rendered on read. */
export type ValueRenderOption = 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA'
/** How append inserts rows relative to existing data. */
export type InsertDataOption = 'OVERWRITE' | 'INSERT_ROWS'

interface ValueRangeResponse {
  range?: string
  majorDimension?: string
  values?: SheetRow[]
}

/** Result of reading a range. */
export interface ReadRangeResult {
  readonly range: string
  readonly values: SheetRow[]
}

export interface ReadRangeInput {
  /** A1 notation, e.g. `Sheet1!A1:C10`. */
  readonly range: string
  readonly valueRenderOption?: ValueRenderOption
}

/** Read a single range via `spreadsheets.values.get`. */
export async function readRange(
  ctx: SheetsRequestContext,
  input: ReadRangeInput,
): Promise<ReadRangeResult> {
  const res = await sheetsRequest<ValueRangeResponse>(ctx, `/values/${encodeRange(input.range)}`, {
    query: { valueRenderOption: input.valueRenderOption },
  })
  return { range: res.range ?? input.range, values: res.values ?? [] }
}

interface BatchGetResponse {
  valueRanges?: ValueRangeResponse[]
}

export interface ReadRangesInput {
  readonly ranges: readonly string[]
  readonly valueRenderOption?: ValueRenderOption
}

/**
 * Read several ranges in one call via `spreadsheets.values:batchGet`. The
 * `values.get` endpoint serves a single range; batchGet is the canonical way to
 * fetch many at once without N round-trips.
 */
export async function readRanges(
  ctx: SheetsRequestContext,
  input: ReadRangesInput,
): Promise<ReadRangeResult[]> {
  const query: Record<string, string | undefined> = {
    valueRenderOption: input.valueRenderOption,
  }
  const url = new URLSearchParams()
  for (const r of input.ranges) url.append('ranges', r)
  const res = await sheetsRequest<BatchGetResponse>(ctx, `/values:batchGet?${url.toString()}`, {
    query,
  })
  return (res.valueRanges ?? []).map((v, i) => ({
    range: v.range ?? input.ranges[i] ?? '',
    values: v.values ?? [],
  }))
}

interface AppendResponse {
  updates?: {
    updatedRange?: string
    updatedRows?: number
    updatedColumns?: number
    updatedCells?: number
  }
}

/** Result of appending rows. */
export interface AppendRowsResult {
  readonly updatedRange: string
  readonly updatedRows: number
  readonly updatedCells: number
}

export interface AppendRowsInput {
  /** A1 range identifying the table to append after, e.g. `Sheet1!A1`. */
  readonly range: string
  readonly values: readonly SheetRow[]
  readonly valueInputOption?: ValueInputOption
  readonly insertDataOption?: InsertDataOption
}

/** Append rows after a table via `spreadsheets.values.append`. */
export async function appendRows(
  ctx: SheetsRequestContext,
  input: AppendRowsInput,
): Promise<AppendRowsResult> {
  const res = await sheetsRequest<AppendResponse>(
    ctx,
    `/values/${encodeRange(input.range)}:append`,
    {
      method: 'POST',
      query: {
        valueInputOption: input.valueInputOption ?? 'USER_ENTERED',
        insertDataOption: input.insertDataOption,
      },
      body: { values: input.values, majorDimension: 'ROWS' },
    },
  )
  return {
    updatedRange: res.updates?.updatedRange ?? input.range,
    updatedRows: res.updates?.updatedRows ?? 0,
    updatedCells: res.updates?.updatedCells ?? 0,
  }
}

interface UpdateResponse {
  updatedRange?: string
  updatedRows?: number
  updatedColumns?: number
  updatedCells?: number
}

/** Result of updating a range. */
export interface UpdateRangeResult {
  readonly updatedRange: string
  readonly updatedRows: number
  readonly updatedCells: number
}

export interface UpdateRangeInput {
  readonly range: string
  readonly values: readonly SheetRow[]
  readonly valueInputOption?: ValueInputOption
}

/** Overwrite a range via `spreadsheets.values.update`. */
export async function updateRange(
  ctx: SheetsRequestContext,
  input: UpdateRangeInput,
): Promise<UpdateRangeResult> {
  const res = await sheetsRequest<UpdateResponse>(ctx, `/values/${encodeRange(input.range)}`, {
    method: 'PUT',
    query: { valueInputOption: input.valueInputOption ?? 'USER_ENTERED' },
    body: { range: input.range, values: input.values, majorDimension: 'ROWS' },
  })
  return {
    updatedRange: res.updatedRange ?? input.range,
    updatedRows: res.updatedRows ?? 0,
    updatedCells: res.updatedCells ?? 0,
  }
}

interface ClearResponse {
  clearedRange?: string
}

/** Result of clearing a range. */
export interface ClearRangeResult {
  readonly clearedRange: string
}

export interface ClearRangeInput {
  readonly range: string
}

/** Clear a range's values via `spreadsheets.values.clear`. */
export async function clearRange(
  ctx: SheetsRequestContext,
  input: ClearRangeInput,
): Promise<ClearRangeResult> {
  const res = await sheetsRequest<ClearResponse>(ctx, `/values/${encodeRange(input.range)}:clear`, {
    method: 'POST',
    body: {},
  })
  return { clearedRange: res.clearedRange ?? input.range }
}

interface SpreadsheetResponse {
  spreadsheetId?: string
  properties?: { title?: string }
  sheets?: { properties?: SheetMetadata }[]
}

/** Metadata for a single sheet/tab within a spreadsheet. */
export interface SheetMetadata {
  readonly sheetId?: number
  readonly title?: string
  readonly index?: number
  readonly gridProperties?: { rowCount?: number; columnCount?: number }
}

/** Result of fetching spreadsheet metadata. */
export interface SpreadsheetMetadata {
  readonly spreadsheetId: string
  readonly title: string
  readonly sheets: SheetMetadata[]
}

/**
 * Fetch spreadsheet/sheet metadata via `spreadsheets.get`. Uses a `fields` mask
 * so the response excludes cell data — cheap enough to double as the health
 * check.
 */
export async function getSpreadsheetMetadata(
  ctx: SheetsRequestContext,
): Promise<SpreadsheetMetadata> {
  const res = await sheetsRequest<SpreadsheetResponse>(ctx, '', {
    query: { fields: 'spreadsheetId,properties.title,sheets.properties' },
  })
  return {
    spreadsheetId: res.spreadsheetId ?? ctx.spreadsheetId,
    title: res.properties?.title ?? '',
    sheets: (res.sheets ?? []).map((s) => s.properties ?? {}),
  }
}

/**
 * Read a range in row-cursor pages. The Sheets `values.get` endpoint is not
 * itself paginated, so this slices the requested range into successive A1
 * row windows of `pageSize` and exhausts them with the SDK {@link paginate}
 * helper, yielding rows. Stops when a page returns fewer rows than requested.
 */
export async function* readRowsPaginated(
  ctx: SheetsRequestContext,
  input: {
    readonly sheet: string
    readonly pageSize?: number
    readonly startRow?: number
    readonly endColumn?: string
    readonly valueRenderOption?: ValueRenderOption
    readonly maxPages?: number
  },
): AsyncGenerator<SheetRow, void, void> {
  const pageSize = input.pageSize ?? 1000
  const endColumn = input.endColumn ?? 'ZZZ'
  const startRow = input.startRow ?? 1

  const fetchPage = async (cursor: string | undefined): Promise<Page<SheetRow>> => {
    const from = cursor === undefined ? startRow : Number.parseInt(cursor, 10)
    const to = from + pageSize - 1
    const range = `${input.sheet}!A${from}:${endColumn}${to}`
    const result = await readRange(ctx, {
      range,
      ...(input.valueRenderOption ? { valueRenderOption: input.valueRenderOption } : {}),
    })
    const nextCursor = result.values.length < pageSize ? undefined : String(to + 1)
    return nextCursor === undefined
      ? { items: result.values }
      : { items: result.values, nextCursor }
  }

  yield* paginate(fetchPage, input.maxPages !== undefined ? { maxPages: input.maxPages } : {})
}

/** Encode an A1 range for safe inclusion in a URL path segment. */
function encodeRange(range: string): string {
  return encodeURIComponent(range)
}
