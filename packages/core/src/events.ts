import type { PermissionDenialReason, PermissionDimension } from './permissions.js'
import type { RunId, RunStatus, SerializedError, StepId, StepKind } from './types-base.js'

/**
 * Discriminated union of run-level events emitted by the runtime. Every
 * event carries enough information to reconstruct a run's behavior offline.
 */
type RunEventBody =
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
      type: 'permission.advisory'
      runId: RunId
      stepId: StepId
      backendId: string
      dimensions: readonly PermissionDimension[]
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
      /** Present when the pause is a human-in-the-loop gate (see hitl.ts). */
      hitl?: import('./hitl.js').HitlPending
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
  | {
      // A run-level guardrail check result. `phase` distinguishes pre/in/post;
      // `status` is pass/warn/fail. Emitted for every check so the dashboard
      // run inspector and the audit log can show guardrail status. See
      // `guardrails.ts`.
      type: 'guardrail.pre' | 'guardrail.post'
      runId: RunId
      check: string
      status: import('./guardrails.js').GuardrailStatus
      severity: 'hard' | 'soft'
      message?: string
      score?: number
      details?: Readonly<Record<string, unknown>>
      at: number
    }
  | {
      // An oversight intervention (pause / escalate / terminate) raised by a
      // budget breach, the watchdog, or the supervisor/critic. The pause/
      // escalate paths are realized through the HITL gate primitive; terminate
      // cancels the run.
      type: 'guardrail.intervention'
      runId: RunId
      stepId?: StepId
      action: import('./guardrails.js').InterventionAction
      source: 'budget' | 'watchdog' | 'supervisor'
      reason: string
      details?: Readonly<Record<string, unknown>>
      at: number
    }
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
  // Task lifecycle events. `runId` is the PARENT run id when the task was
  // spawned from a run, else the child run id, so the event always rides on a
  // bus a subscriber is already watching. Payloads stay small.
  | {
      type: 'task.created'
      runId: RunId
      taskId: string
      childRunId?: RunId
      at: number
    }
  | {
      type: 'task.completed'
      runId: RunId
      taskId: string
      childRunId?: RunId
      /** Short result summary, when available. */
      summary?: string
      at: number
    }
  | {
      type: 'task.failed'
      runId: RunId
      taskId: string
      childRunId?: RunId
      error: SerializedError
      at: number
    }
  | {
      type: 'task.cancelled'
      runId: RunId
      taskId: string
      childRunId?: RunId
      at: number
    }

/**
 * A run event. `EventBus.publish` stamps a monotonic per-run `seq` before
 * fan-out, giving consumers an unambiguous total order within a run even when
 * many events share a wall-clock millisecond (a fast LLM can emit dozens of
 * `step.partial` tokens per ms). The same value is carried on the persisted
 * copy, so SSE replay/tail-merge dedup is exact, and it is the basis for
 * deterministic event-log ordering.
 */
export type RunEvent = RunEventBody & { seq?: number }

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
  private readonly seqByRun: Map<RunId, number> = new Map()

  publish(event: RunEvent): void {
    // Stamp a monotonic per-run sequence once, before fan-out, so live
    // subscribers and the persisted copy share the same `seq`. This gives an
    // unambiguous order within a run even when events collide on `at` (ms).
    if (event.seq === undefined) {
      const next = (this.seqByRun.get(event.runId) ?? 0) + 1
      this.seqByRun.set(event.runId, next)
      event.seq = next
    }
    for (const listener of this.listeners) {
      this.invoke(listener, event)
    }
    const indexed = this.byRun.get(event.runId)
    if (indexed !== undefined) {
      for (const listener of indexed) {
        this.invoke(listener, event)
      }
    }
    // Release the per-run counter once the run reaches a terminal event so the
    // map doesn't grow unbounded across many runs.
    if (
      event.type === 'run.completed' ||
      event.type === 'run.failed' ||
      event.type === 'run.cancelled'
    ) {
      this.seqByRun.delete(event.runId)
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
