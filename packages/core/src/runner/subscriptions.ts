import type { AuditEvent, AuditWriter } from '../enforcement/index.js'
import type { EventBus } from '../events.js'
import { ALL_PERMISSION_DIMENSIONS } from '../permissions.js'
import type { RunStore } from '../run-store.js'

const APPEND_BACKPRESSURE_CAP = 256

export function writeAudit(writer: AuditWriter, entry: AuditEvent): Promise<void> {
  return writer.write(entry).catch((err) => {
    const detail = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `[skelm audit] write failed (action=${entry.action} run=${entry.runId ?? '-'}): ${detail}\n`,
    )
  })
}

export function logStoreFailure(label: string, runId: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  process.stderr.write(`[skelm run-store] ${label} write failed for run ${runId}: ${detail}\n`)
}

export function subscribeStoreEvents(opts: {
  events: EventBus
  runId: string
  store: RunStore | undefined
  storeWrites: Promise<void>[]
}): (() => void) | undefined {
  const { events, runId, store, storeWrites } = opts
  if (store === undefined) return undefined

  let appendInflight = 0
  let appendSaturated = false
  return events.forRun(runId, (event) => {
    appendInflight += 1
    if (appendInflight >= APPEND_BACKPRESSURE_CAP && !appendSaturated) {
      appendSaturated = true
      events.publish({
        type: 'run.warning',
        runId,
        code: 'store.saturated',
        message: `appendEvent queue depth reached ${appendInflight} (cap ${APPEND_BACKPRESSURE_CAP})`,
        at: Date.now(),
      })
    }
    storeWrites.push(
      Promise.resolve()
        .then(() => store.appendEvent(event))
        .catch((err) => logStoreFailure('append-event', runId, err))
        .finally(() => {
          appendInflight -= 1
          if (appendSaturated && appendInflight === 0) {
            appendSaturated = false
            events.publish({
              type: 'run.warning',
              runId,
              code: 'store.recovered',
              message: 'appendEvent queue drained',
              at: Date.now(),
            })
          }
        }),
    )
  })
}

export function subscribeRunStateMirror(opts: {
  events: EventBus
  runId: string
  store: RunStore | undefined
  storeWrites: Promise<void>[]
}): (() => void) | undefined {
  const { events, runId, store, storeWrites } = opts
  if (store === undefined) return undefined

  return events.forRun(runId, (event) => {
    if (event.type === 'run.waiting') {
      storeWrites.push(
        store
          .updateRun(event.runId, {
            status: 'waiting',
            waiting: {
              stepId: event.stepId,
              ...(event.message !== undefined && { message: event.message }),
              ...(event.timeoutMs !== undefined && { timeoutMs: event.timeoutMs }),
              ...(event.hitl !== undefined && { hitl: event.hitl }),
              since: event.at,
            },
          })
          .catch((err) => logStoreFailure('waiting-status', event.runId, err)),
      )
    } else if (event.type === 'run.resumed') {
      storeWrites.push(
        store
          .updateRun(event.runId, { status: 'running', waiting: undefined })
          .catch((err) => logStoreFailure('resume-status', event.runId, err)),
      )
    }
  })
}

export function subscribeAuditEvents(opts: {
  events: EventBus
  runId: string
  auditWriter: AuditWriter | undefined
  auditWrites: Promise<void>[]
}): (() => void) | undefined {
  const { events, runId, auditWriter, auditWrites } = opts
  if (auditWriter === undefined) return undefined

  return events.forRun(runId, (event) => {
    const queue = (entry: { action: string; details: Record<string, unknown> }) => {
      auditWrites.push(
        writeAudit(auditWriter, {
          ...(event.runId !== undefined && { runId: event.runId }),
          actor: 'runtime',
          action: entry.action,
          details: entry.details,
        }),
      )
    }
    if (event.type === 'permission.denied') {
      queue({
        action: 'permission.denied',
        details: {
          stepId: event.stepId,
          dimension: event.dimension,
          detail: event.detail,
          at: event.at,
        },
      })
    } else if (event.type === 'permission.advisory') {
      queue({
        action: 'permission.advisory',
        details: {
          stepId: event.stepId,
          backendId: event.backendId,
          dimensions: event.dimensions,
          detail: event.detail,
          at: event.at,
        },
      })
    } else if (event.type === 'permission.bypassed') {
      auditWrites.push(
        writeAudit(auditWriter, {
          ...(event.runId !== undefined && { runId: event.runId }),
          actor: 'step-author',
          action: 'permission.bypassed',
          details: {
            stepId: event.stepId,
            detail: event.detail,
            at: event.at,
            dimensions: [...ALL_PERMISSION_DIMENSIONS],
          },
        }),
      )
      for (const dimension of ALL_PERMISSION_DIMENSIONS) {
        auditWrites.push(
          writeAudit(auditWriter, {
            ...(event.runId !== undefined && { runId: event.runId }),
            actor: 'step-author',
            action: `permission.bypass.${dimension}`,
            details: { stepId: event.stepId, dimension, at: event.at },
          }),
        )
      }
    } else if (event.type === 'secret.not_found') {
      queue({
        action: 'secret.not_found',
        details: { stepId: event.stepId, name: event.name, at: event.at },
      })
    } else if (event.type === 'backend.failover') {
      queue({
        action: 'backend.failover',
        details: {
          stepId: event.stepId,
          kind: event.kind,
          from: event.from,
          to: event.to,
          error: event.error,
          at: event.at,
        },
      })
    } else if (event.type === 'tool.call') {
      queue({
        action: 'tool.call',
        details: { stepId: event.stepId, tool: event.tool, at: event.at },
      })
    } else if (event.type === 'tool.result') {
      queue({
        action: 'tool.result',
        details: {
          stepId: event.stepId,
          tool: event.tool,
          durationMs: event.durationMs,
          at: event.at,
        },
      })
    }
  })
}
