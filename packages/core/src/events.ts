import type { PermissionDenialReason, PermissionDimension } from './permissions.js'
import type { RunId, RunStatus, SerializedError, StepId, StepKind } from './types-base.js'

/**
 * Discriminated union of run-level events emitted by the runtime. Every
 * event carries enough information to reconstruct a run's behavior offline.
 */
export type RunEvent =
  | { type: 'run.created'; runId: RunId; pipelineId: string; input: unknown; at: number }
  | { type: 'run.started'; runId: RunId; at: number }
  | {
      type: 'step.start'
      runId: RunId
      stepId: StepId
      kind: StepKind
      at: number
    }
  | {
      type: 'step.complete'
      runId: RunId
      stepId: StepId
      kind: StepKind
      output: unknown
      durationMs: number
      at: number
    }
  | {
      type: 'step.error'
      runId: RunId
      stepId: StepId
      kind: StepKind
      error: SerializedError
      at: number
    }
  | {
      type: 'step.skipped'
      runId: RunId
      stepId: StepId
      kind: StepKind
      at: number
    }
  | {
      type: 'tool.call'
      runId: RunId
      stepId: StepId
      tool: string
      arguments: unknown
      at: number
    }
  | {
      type: 'tool.result'
      runId: RunId
      stepId: StepId
      tool: string
      result: unknown
      durationMs: number
      at: number
    }
  | {
      type: 'tool.denied'
      runId: RunId
      stepId: StepId
      tool: string
      reason: PermissionDenialReason
      at: number
    }
  | {
      type: 'permission.denied'
      runId: RunId
      stepId: StepId
      dimension: PermissionDimension
      detail: string
      at: number
    }
  | {
      type: 'backend.failover'
      runId: RunId
      stepId: StepId
      kind: Extract<StepKind, 'infer' | 'agent'>
      from: string
      to: string
      error: string
      at: number
    }
  | {
      // Emitted once when a step/turn resolves to a full permission bypass
      // (operator-granted `unrestricted`). Never silent: this is the audit
      // signal that the default-deny model was intentionally short-circuited.
      type: 'permission.bypassed'
      runId: RunId
      stepId: StepId
      detail: string
      at: number
    }
  | {
      type: 'step.retry'
      runId: RunId
      stepId: StepId
      kind: StepKind
      attempt: number
      error: SerializedError
      delayMs?: number
      at: number
    }
  | {
      type: 'run.waiting'
      runId: RunId
      stepId: StepId
      message?: string
      timeoutMs?: number
      at: number
    }
  | {
      type: 'run.resumed'
      runId: RunId
      stepId: StepId
      output: unknown
      at: number
    }
  | { type: 'run.completed'; runId: RunId; output: unknown; durationMs: number; at: number }
  | { type: 'run.failed'; runId: RunId; error: SerializedError; at: number }
  | { type: 'run.cancelled'; runId: RunId; at: number }
  | { type: 'secret.accessed'; runId: RunId; stepId: string; name: string; at: number }
  | { type: 'secret.not_found'; runId: RunId; stepId: string; name: string; at: number }
  | {
      type: 'run.warning'
      runId: RunId
      stepId?: StepId
      code: string
      message: string
      at: number
    }
  | {
      type: 'step.partial'
      runId: RunId
      stepId: StepId
      kind: StepKind
      /** Partial text delta (not cumulative — each event is one new chunk). */
      delta: string
      at: number
    }

export type RunEventType = RunEvent['type']

/** A subscriber receives every event in publication order. */
export type EventListener = (event: RunEvent) => void

/**
 * Minimal in-process event bus used by the runtime. Synchronous publish
 * (subscribers must complete before publish returns); subscribers run in
 * registration order; each subscriber's exception is caught and logged
 * to stderr but does not break the bus or other subscribers.
 *
 * forRun() subscribers are indexed by runId so publish() only fans out to
 * listeners interested in the event's runId — keeping per-publish work
 * O(global + per-run) instead of O(total).
 */
export class EventBus {
  private readonly listeners: Set<EventListener> = new Set()
  private readonly byRun: Map<RunId, Set<EventListener>> = new Map()

  publish(event: RunEvent): void {
    for (const listener of this.listeners) {
      this.invoke(listener, event)
    }
    const indexed = this.byRun.get(event.runId)
    if (indexed !== undefined) {
      for (const listener of indexed) {
        this.invoke(listener, event)
      }
    }
  }

  private invoke(listener: EventListener, event: RunEvent): void {
    try {
      listener(event)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[skelm event subscriber error] ${detail}\n`)
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Subscribe only to events for a specific runId. Indexed by runId so
   * publish() does not iterate unrelated subscribers.
   */
  forRun(runId: RunId, listener: EventListener): () => void {
    let set = this.byRun.get(runId)
    if (set === undefined) {
      set = new Set()
      this.byRun.set(runId, set)
    }
    set.add(listener)
    return () => {
      const s = this.byRun.get(runId)
      if (s === undefined) return
      s.delete(listener)
      if (s.size === 0) this.byRun.delete(runId)
    }
  }

  /** Total active listeners across global + per-run indexes. */
  get listenerCount(): number {
    let n = this.listeners.size
    for (const s of this.byRun.values()) n += s.size
    return n
  }
}

/** Map a RunStatus to the corresponding terminal event type, if any. */
export function terminalEventTypeFor(status: RunStatus): RunEventType | null {
  switch (status) {
    case 'completed':
      return 'run.completed'
    case 'failed':
      return 'run.failed'
    case 'cancelled':
      return 'run.cancelled'
    default:
      return null
  }
}
