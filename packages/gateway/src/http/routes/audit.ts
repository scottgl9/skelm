import { join } from 'node:path'
import { type Router, createError, eventHandler, getQuery, readBody } from 'h3'
import { type AuditExportFormat, ChainAuditWriter } from '../../audit/chain.js'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'

/**
 * Audit log read API. Backed by the gateway's existing ChainAuditWriter at
 * <stateDir>/audit.jsonl. Returns the same shape the CLI used to read in-
 * process, so the only difference for callers is the transport.
 *
 * GET /audit         — filtered, bounded list of chain entries (tail by default)
 *   query: runId?, actor?, action?, since?, until?, limit?, before?
 *   `limit` defaults to 500, hard-capped at 5000, so a single GET never
 *   materialises an unbounded audit log. `before` is a seq cursor for
 *   backwards paging: pass the lowest seq from a page to fetch the next-older
 *   page.
 * GET /audit/verify  — walk the chain and report the first integrity break
 * GET /v1/audit/export — stream the filtered log as JSONL or CSV (no limit;
 *   honors the same filters as /audit). Streamed line-by-line so memory stays
 *   bounded regardless of log size.
 * POST /v1/audit/prune — archive the head of the log (seq <= before) to a
 *   sibling segment and rewrite the live log to the retained tail. Destructive;
 *   refuses unless the body sets { confirm: true }.
 */
export function registerAuditRoutes(router: Router, gateway: GatewayContext): void {
  // The gateway uses ChainAuditWriter against <stateDir>/audit.jsonl when no
  // explicit auditWriter is injected. Constructing a sibling reader against
  // the same path here is safe — ChainAuditWriter.readAll() opens, reads,
  // closes; no shared mutable state.
  const auditPath = join(gateway.stateDir, 'audit.jsonl')

  router.get(
    '/audit',
    eventHandler(async (event) => {
      const q = getQuery(event)
      const reader = new ChainAuditWriter(auditPath)
      const runId = stringOf(q.runId)
      const actor = stringOf(q.actor)
      const action = stringOf(q.action)
      const since = stringOf(q.since)
      const until = stringOf(q.until)
      const limitRaw = stringOf(q.limit)
      const limit =
        limitRaw === undefined ? undefined : Math.max(1, Math.min(5000, Number(limitRaw)))
      if (limitRaw !== undefined && Number.isNaN(Number(limitRaw))) {
        throw createError({ statusCode: 400, message: 'limit: invalid integer' })
      }
      const beforeRaw = stringOf(q.before)
      const before = beforeRaw === undefined ? undefined : Number(beforeRaw)
      if (before !== undefined && (Number.isNaN(before) || before < 1)) {
        throw createError({ statusCode: 400, message: 'before: invalid seq cursor' })
      }
      const sinceTs = since !== undefined ? Date.parse(since) : null
      const untilTs = until !== undefined ? Date.parse(until) : null
      if (since !== undefined && Number.isNaN(sinceTs)) {
        throw createError({ statusCode: 400, message: 'since: invalid timestamp' })
      }
      if (until !== undefined && Number.isNaN(untilTs)) {
        throw createError({ statusCode: 400, message: 'until: invalid timestamp' })
      }
      const entries = await reader.list({
        ...(runId !== undefined && { runId }),
        ...(actor !== undefined && { actor }),
        ...(action !== undefined && { action }),
        ...(since !== undefined && { since }),
        ...(until !== undefined && { until }),
        ...(limit !== undefined && { limit }),
        ...(before !== undefined && { before }),
      })
      // nextBefore is the cursor for the next-older page: the lowest seq in
      // this page. null when the page is empty (nothing older to fetch).
      const nextBefore = entries.length > 0 ? (entries[0]?.seq ?? null) : null
      return { entries, nextBefore }
    }),
  )

  router.get(
    '/audit/verify',
    eventHandler(async () => {
      const reader = new ChainAuditWriter(auditPath)
      const breach = await reader.verify()
      return { ok: breach === null, ...(breach !== null && { breach }) }
    }),
  )

  router.get(
    '/v1/audit/export',
    eventHandler(async (event) => {
      const q = getQuery(event)
      const formatRaw = stringOf(q.format) ?? 'jsonl'
      if (formatRaw !== 'jsonl' && formatRaw !== 'csv') {
        throw createError({ statusCode: 400, message: 'format: must be jsonl or csv' })
      }
      const format = formatRaw as AuditExportFormat
      const filter = parseAuditFilter(q)
      const reader = new ChainAuditWriter(auditPath)

      // Raw streaming response: write each line as it streams off the chain so
      // the whole log is never materialised. Mirrors the SSE pattern in
      // server.ts — take over the node response and flush headers up front.
      const res = event.node.res
      event._handled = true
      res.writeHead(200, {
        'Content-Type':
          format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      })
      const write = (chunk: string): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          if (res.write(chunk)) {
            resolve()
            return
          }
          res.once('drain', resolve)
          res.once('error', reject)
        })
      try {
        await reader.export(filter, format, write)
      } finally {
        if (!res.writableEnded) res.end()
      }
      return undefined
    }),
  )

  router.post(
    '/v1/audit/prune',
    eventHandler(async (event) => {
      const raw = await readBody(event).catch(() => undefined)
      const body = (raw ?? {}) as { before?: unknown; confirm?: unknown }
      const before = Number(body.before)
      if (!Number.isInteger(before) || before < 1) {
        throw createError({ statusCode: 400, message: 'before: required integer seq >= 1' })
      }
      if (body.confirm !== true) {
        throw createError({
          statusCode: 400,
          message:
            'prune is destructive: pass confirm:true. The archived head and retained tail verify separately, not as one chain.',
        })
      }
      const writer = new ChainAuditWriter(auditPath)
      const result = await writer.prune(before)
      await gateway.enforcement.auditWriter.write({
        actor: 'gateway',
        action: 'audit.pruned',
        details: {
          before,
          archived: result.archived,
          retained: result.retained,
          prunedThroughSeq: result.boundary.prunedThroughSeq,
        },
      })
      return result
    }),
  )
}

function parseAuditFilter(q: Record<string, unknown>): {
  runId?: string
  actor?: string
  action?: string
  since?: string
  until?: string
  before?: number
} {
  const runId = stringOf(q.runId)
  const actor = stringOf(q.actor)
  const action = stringOf(q.action)
  const since = stringOf(q.since)
  const until = stringOf(q.until)
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    throw createError({ statusCode: 400, message: 'since: invalid timestamp' })
  }
  if (until !== undefined && Number.isNaN(Date.parse(until))) {
    throw createError({ statusCode: 400, message: 'until: invalid timestamp' })
  }
  const beforeRaw = stringOf(q.before)
  const before = beforeRaw === undefined ? undefined : Number(beforeRaw)
  if (before !== undefined && (Number.isNaN(before) || before < 1)) {
    throw createError({ statusCode: 400, message: 'before: invalid seq cursor' })
  }
  return {
    ...(runId !== undefined && { runId }),
    ...(actor !== undefined && { actor }),
    ...(action !== undefined && { action }),
    ...(since !== undefined && { since }),
    ...(until !== undefined && { until }),
    ...(before !== undefined && { before }),
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
