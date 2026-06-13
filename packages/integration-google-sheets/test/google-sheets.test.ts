import type { CredentialReference, EgressPolicy } from '@skelm/integration-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GOOGLE_SHEETS_PROVIDER,
  SHEETS_API_HOST,
  SheetsApiError,
  type SheetsRequestContext,
  appendRows,
  buildSheetsContext,
  checkSheetsHealth,
  clearRange,
  getSpreadsheetMetadata,
  googleSheetsCredentialSchema,
  googleSheetsManifest,
  googleSheetsTokenReference,
  isRetryableSheetsError,
  pollNewRows,
  readRange,
  readRanges,
  readRowsPaginated,
  redactBearer,
  sheetsRequest,
  updateRange,
} from '../src/index.js'

const TOKEN = 'ya29.SUPER-SECRET-TOKEN-value'
const SPREADSHEET = 'sheet-123'

const allowAll: EgressPolicy = () => ({ allow: true })
const denyAll: EgressPolicy = () => ({ allow: false, reason: 'host not allowlisted' })

/** Capture the requests made and return canned JSON responses in order. */
function fakeFetch(responses: Array<{ status?: number; body: unknown } | Error>): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses[Math.min(i, responses.length - 1)]
    i++
    if (next instanceof Error) throw next
    const status = next.status ?? 200
    return new Response(JSON.stringify(next.body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function ctxWith(
  responses: Parameters<typeof fakeFetch>[0],
  overrides: Partial<SheetsRequestContext> = {},
): { ctx: SheetsRequestContext; calls: Array<{ url: string; init: RequestInit }> } {
  const { fetchImpl, calls } = fakeFetch(responses)
  const ctx: SheetsRequestContext = {
    spreadsheetId: SPREADSHEET,
    accessToken: TOKEN,
    egress: allowAll,
    fetchImpl,
    retry: { sleep: async () => {} },
    ...overrides,
  }
  return { ctx, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readRange (values.get)', () => {
  it('shapes the A1 range and value-render option, maps the response', async () => {
    const { ctx, calls } = ctxWith([
      {
        body: {
          range: 'Sheet1!A1:B2',
          values: [
            ['a', 'b'],
            ['c', 'd'],
          ],
        },
      },
    ])
    const result = await readRange(ctx, {
      range: 'Sheet1!A1:B2',
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
    expect(result.values).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    const url = calls[0]!.url
    expect(url).toContain(`/v4/spreadsheets/${SPREADSHEET}/values/`)
    expect(url).toContain(encodeURIComponent('Sheet1!A1:B2'))
    expect(url).toContain('valueRenderOption=UNFORMATTED_VALUE')
    expect(calls[0]!.init.method).toBe('GET')
  })

  it('defaults missing values to an empty array', async () => {
    const { ctx } = ctxWith([{ body: { range: 'Sheet1!A1' } }])
    const result = await readRange(ctx, { range: 'Sheet1!A1' })
    expect(result.values).toEqual([])
  })
})

describe('readRanges (values:batchGet)', () => {
  it('appends each range and maps valueRanges', async () => {
    const { ctx, calls } = ctxWith([
      {
        body: {
          valueRanges: [
            { range: 'Sheet1!A1:A2', values: [['x'], ['y']] },
            { range: 'Sheet1!B1:B2', values: [['1'], ['2']] },
          ],
        },
      },
    ])
    const result = await readRanges(ctx, { ranges: ['Sheet1!A1:A2', 'Sheet1!B1:B2'] })
    expect(result).toHaveLength(2)
    expect(result[1]!.values).toEqual([['1'], ['2']])
    expect(calls[0]!.url).toContain('values:batchGet?')
    expect(calls[0]!.url).toContain('ranges=Sheet1%21A1%3AA2')
  })
})

describe('appendRows (values.append)', () => {
  it('POSTs values with valueInputOption and ROWS major dimension', async () => {
    const { ctx, calls } = ctxWith([
      { body: { updates: { updatedRange: 'Sheet1!A3:B3', updatedRows: 1, updatedCells: 2 } } },
    ])
    const result = await appendRows(ctx, {
      range: 'Sheet1!A1',
      values: [['new', 'row']],
      valueInputOption: 'RAW',
    })
    expect(result.updatedRows).toBe(1)
    expect(result.updatedCells).toBe(2)
    const init = calls[0]!.init
    expect(init.method).toBe('POST')
    expect(calls[0]!.url).toContain(':append')
    expect(calls[0]!.url).toContain('valueInputOption=RAW')
    expect(JSON.parse(init.body as string)).toEqual({
      values: [['new', 'row']],
      majorDimension: 'ROWS',
    })
  })

  it('defaults valueInputOption to USER_ENTERED', async () => {
    const { ctx, calls } = ctxWith([{ body: { updates: {} } }])
    await appendRows(ctx, { range: 'Sheet1!A1', values: [['x']] })
    expect(calls[0]!.url).toContain('valueInputOption=USER_ENTERED')
  })
})

describe('updateRange (values.update)', () => {
  it('PUTs values to the range', async () => {
    const { ctx, calls } = ctxWith([
      { body: { updatedRange: 'Sheet1!A1:A1', updatedRows: 1, updatedCells: 1 } },
    ])
    const result = await updateRange(ctx, { range: 'Sheet1!A1', values: [['v']] })
    expect(result.updatedCells).toBe(1)
    expect(calls[0]!.init.method).toBe('PUT')
    expect(calls[0]!.url).toContain('valueInputOption=USER_ENTERED')
  })
})

describe('clearRange (values.clear)', () => {
  it('POSTs an empty body to :clear and maps clearedRange', async () => {
    const { ctx, calls } = ctxWith([{ body: { clearedRange: 'Sheet1!A1:B2' } }])
    const result = await clearRange(ctx, { range: 'Sheet1!A1:B2' })
    expect(result.clearedRange).toBe('Sheet1!A1:B2')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.url).toContain(':clear')
  })
})

describe('getSpreadsheetMetadata (spreadsheets.get)', () => {
  it('requests a fields mask and maps sheet properties', async () => {
    const { ctx, calls } = ctxWith([
      {
        body: {
          spreadsheetId: SPREADSHEET,
          properties: { title: 'Demo' },
          sheets: [{ properties: { sheetId: 0, title: 'Sheet1', index: 0 } }],
        },
      },
    ])
    const meta = await getSpreadsheetMetadata(ctx)
    expect(meta.title).toBe('Demo')
    expect(meta.sheets[0]!.title).toBe('Sheet1')
    expect(calls[0]!.url).toContain('fields=')
  })
})

describe('readRowsPaginated', () => {
  it('exhausts pages until a short page, yielding rows', async () => {
    const { ctx, calls } = ctxWith([
      { body: { values: [['1'], ['2']] } },
      { body: { values: [['3']] } },
    ])
    const rows: unknown[] = []
    for await (const row of readRowsPaginated(ctx, { sheet: 'Sheet1', pageSize: 2 })) {
      rows.push(row)
    }
    expect(rows).toEqual([['1'], ['2'], ['3']])
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain(encodeURIComponent('Sheet1!A1:ZZZ2'))
    expect(calls[1]!.url).toContain(encodeURIComponent('Sheet1!A3:ZZZ4'))
  })

  it('respects maxPages', async () => {
    const { ctx, calls } = ctxWith([
      { body: { values: [['1'], ['2']] } },
      { body: { values: [['3'], ['4']] } },
    ])
    const rows: unknown[] = []
    for await (const row of readRowsPaginated(ctx, { sheet: 'Sheet1', pageSize: 2, maxPages: 1 })) {
      rows.push(row)
    }
    expect(rows).toEqual([['1'], ['2']])
    expect(calls).toHaveLength(1)
  })
})

describe('pollNewRows trigger', () => {
  it('treats the first poll as baseline and emits no rows', async () => {
    const { ctx } = ctxWith([{ body: { values: [['a'], ['b'], ['c']] } }])
    const result = await pollNewRows(ctx, { sheet: 'Sheet1' })
    expect(result.newRows).toEqual([])
    expect(result.cursor).toBe(3)
  })

  it('emits only rows appended after the cursor', async () => {
    const { ctx } = ctxWith([{ body: { values: [['a'], ['b'], ['c'], ['d']] } }])
    const result = await pollNewRows(ctx, { sheet: 'Sheet1', cursor: 2 })
    expect(result.newRows).toEqual([['c'], ['d']])
    expect(result.cursor).toBe(4)
  })

  it('emits nothing when the row count did not grow', async () => {
    const { ctx } = ctxWith([{ body: { values: [['a'], ['b']] } }])
    const result = await pollNewRows(ctx, { sheet: 'Sheet1', cursor: 2 })
    expect(result.newRows).toEqual([])
    expect(result.cursor).toBe(2)
  })
})

describe('egress enforcement', () => {
  it('refuses a denied host and never calls fetch', async () => {
    const fetchSpy = vi.fn()
    const ctx: SheetsRequestContext = {
      spreadsheetId: SPREADSHEET,
      accessToken: TOKEN,
      egress: denyAll,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      retry: { sleep: async () => {} },
    }
    await expect(readRange(ctx, { range: 'Sheet1!A1' })).rejects.toThrow(/Egress denied/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('targets the sheets.googleapis.com host', () => {
    expect(SHEETS_API_HOST).toBe('sheets.googleapis.com')
  })
})

describe('retry / rate-limit classification', () => {
  it('retries a 429 then succeeds', async () => {
    const { ctx, calls } = ctxWith([
      {
        status: 429,
        body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'slow down' } },
      },
      { body: { range: 'Sheet1!A1', values: [['ok']] } },
    ])
    const result = await readRange(ctx, { range: 'Sheet1!A1' })
    expect(result.values).toEqual([['ok']])
    expect(calls).toHaveLength(2)
  })

  it('retries a 503 then succeeds', async () => {
    const { ctx, calls } = ctxWith([
      { status: 503, body: { error: { message: 'unavailable' } } },
      { body: { values: [['ok']] } },
    ])
    await readRange(ctx, { range: 'Sheet1!A1' })
    expect(calls).toHaveLength(2)
  })

  it('does not retry a 404 and throws a classified error', async () => {
    const { ctx, calls } = ctxWith([
      {
        status: 404,
        body: { error: { code: 404, status: 'NOT_FOUND', message: 'no such sheet' } },
      },
    ])
    const err = await readRange(ctx, { range: 'Sheet1!A1' }).catch((e) => e)
    expect(err).toBeInstanceOf(SheetsApiError)
    expect((err as SheetsApiError).status).toBe(404)
    expect((err as SheetsApiError).googleStatus).toBe('NOT_FOUND')
    expect(calls).toHaveLength(1)
  })

  it('classifies retryability by status', () => {
    expect(isRetryableSheetsError(new SheetsApiError('x', 429))).toBe(true)
    expect(isRetryableSheetsError(new SheetsApiError('x', 500))).toBe(true)
    expect(isRetryableSheetsError(new SheetsApiError('x', 404))).toBe(false)
  })

  it('gives up after maxAttempts on persistent 500s', async () => {
    const { ctx, calls } = ctxWith([{ status: 500, body: { error: { message: 'boom' } } }])
    await expect(
      readRange(
        { ...ctx, retry: { sleep: async () => {}, maxAttempts: 3 } },
        { range: 'Sheet1!A1' },
      ),
    ).rejects.toBeInstanceOf(SheetsApiError)
    expect(calls).toHaveLength(3)
  })
})

describe('credential / bearer assembly + redaction', () => {
  it('builds the Authorization header from the resolved token', async () => {
    const { ctx, calls } = ctxWith([{ body: { values: [] } }])
    await readRange(ctx, { range: 'Sheet1!A1' })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('buildSheetsContext accepts a credential reference and rejects a smuggled value', () => {
    const ref = googleSheetsTokenReference('GOOGLE_SHEETS_ACCESS_TOKEN')
    const built = buildSheetsContext({
      spreadsheetId: SPREADSHEET,
      tokenReference: ref,
      resolvedAccessToken: TOKEN,
      egress: allowAll,
    })
    expect(built.accessToken).toBe(TOKEN)

    const leaky = { ...ref, accessToken: TOKEN } as unknown as CredentialReference
    expect(() =>
      buildSheetsContext({
        spreadsheetId: SPREADSHEET,
        tokenReference: leaky,
        resolvedAccessToken: TOKEN,
        egress: allowAll,
      }),
    ).toThrow(/must not carry a secret value/)
  })

  it('redactBearer scrubs token-shaped strings', () => {
    expect(redactBearer(`token=${TOKEN} done`)).not.toContain('SUPER-SECRET')
    expect(redactBearer(`Authorization: Bearer ${TOKEN}`)).toContain('[REDACTED]')
  })

  it('never leaks the token in a thrown error message', async () => {
    const { ctx } = ctxWith([
      { status: 403, body: { error: { code: 403, message: `denied for ${TOKEN}` } } },
    ])
    const err = await readRange(ctx, { range: 'Sheet1!A1' }).catch((e) => e as Error)
    expect((err as Error).message).not.toContain('SUPER-SECRET')
    expect((err as Error).message).not.toContain(TOKEN)
  })

  it('never leaks the token through a health-check detail', async () => {
    const { ctx } = ctxWith([
      { status: 401, body: { error: { code: 401, message: `bad token ${TOKEN}` } } },
    ])
    const health = await checkSheetsHealth(ctx)
    expect(health.healthy).toBe(false)
    expect(health.detail ?? '').not.toContain(TOKEN)
  })
})

describe('health check', () => {
  it('reports healthy on a successful metadata GET', async () => {
    const { ctx } = ctxWith([
      {
        body: {
          spreadsheetId: SPREADSHEET,
          properties: { title: 'X' },
          sheets: [{ properties: {} }],
        },
      },
    ])
    const health = await checkSheetsHealth(ctx)
    expect(health.healthy).toBe(true)
    expect(health.status).toBe('ok')
  })
})

describe('manifest', () => {
  it('declares actions, the poll trigger, network permission, and token credential', () => {
    expect(googleSheetsManifest.name).toBe('@skelm/integration-google-sheets')
    const actionIds = (googleSheetsManifest.actions ?? []).map((a) => a.id)
    expect(actionIds).toContain('readRange')
    expect(actionIds).toContain('appendRows')
    expect(actionIds).toContain('getSpreadsheetMetadata')
    expect(googleSheetsManifest.triggers?.[0]?.kind).toBe('poll')
    expect(googleSheetsManifest.requiredPermissions).toContain('network')
    expect(googleSheetsCredentialSchema.fields[0]!.kind).toBe('token')
  })

  it('declares an audit redaction policy covering the bearer token', () => {
    const paths = googleSheetsManifest.auditRedaction?.redactPaths ?? []
    expect(paths).toContain('accessToken')
    expect(paths).toContain('headers.authorization')
  })

  it('gates the live test on SKELM_LIVE_GOOGLE_SHEETS', () => {
    const live = googleSheetsManifest.liveTests?.[0]
    expect(live?.provider).toBe(GOOGLE_SHEETS_PROVIDER)
    expect(live?.requiredEnv).toContain('SKELM_LIVE_GOOGLE_SHEETS')
  })

  it('ships a mock fixture for deterministic CI', () => {
    const fixture = googleSheetsManifest.mockFixtures?.[0]
    expect(fixture?.provider).toBe(GOOGLE_SHEETS_PROVIDER)
    expect(fixture?.payloads['values.get']).toBeDefined()
  })
})

describe('sheetsRequest egress denial is structural', () => {
  it('throws before any fetch when egress denies', async () => {
    const fetchSpy = vi.fn()
    await expect(
      sheetsRequest(
        {
          spreadsheetId: SPREADSHEET,
          accessToken: TOKEN,
          egress: denyAll,
          fetchImpl: fetchSpy as unknown as typeof fetch,
          retry: { sleep: async () => {} },
        },
        '',
      ),
    ).rejects.toThrow(/Egress denied/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
