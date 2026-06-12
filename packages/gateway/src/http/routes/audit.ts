import { join } from 'node:path'
import { type Router, createError, eventHandler, getQuery } from 'h3'
import { ChainAuditWriter } from '../../audit/chain.js'
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
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
