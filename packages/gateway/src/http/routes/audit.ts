import { join } from 'node:path'
import { type Router, createError, eventHandler, getQuery } from 'h3'
import { ChainAuditWriter } from '../../audit/chain.js'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'

/**
 * Audit log read API. Backed by the gateway's existing ChainAuditWriter at
 * <stateDir>/audit.jsonl. Returns the same shape the CLI used to read in-
 * process, so the only difference for callers is the transport.
 *
 * GET /audit         — filtered list of chain entries
 *   query: runId?, actor?, action?, since?, until?, limit?
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
      const all = await reader.readAll()
      const runId = stringOf(q.runId)
      const actor = stringOf(q.actor)
      const action = stringOf(q.action)
      const since = stringOf(q.since)
      const until = stringOf(q.until)
      const limitRaw = stringOf(q.limit)
      const limit =
        limitRaw === undefined ? undefined : Math.max(1, Math.min(5000, Number(limitRaw)))
      const sinceTs = since !== undefined ? Date.parse(since) : null
      const untilTs = until !== undefined ? Date.parse(until) : null
      if (since !== undefined && Number.isNaN(sinceTs)) {
        throw createError({ statusCode: 400, message: 'since: invalid timestamp' })
      }
      if (until !== undefined && Number.isNaN(untilTs)) {
        throw createError({ statusCode: 400, message: 'until: invalid timestamp' })
      }
      const filtered = all.filter((e) => {
        if (runId !== undefined && e.runId !== runId) return false
        if (actor !== undefined && e.actor !== actor) return false
        if (action !== undefined && e.action !== action) return false
        const ts = Date.parse(e.timestamp)
        if (sinceTs !== null && ts < sinceTs) return false
        if (untilTs !== null && ts > untilTs) return false
        return true
      })
      return { entries: limit === undefined ? filtered : filtered.slice(-limit) }
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
