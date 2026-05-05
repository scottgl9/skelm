import type { PermissionDenialReason, PermissionDimension } from './permissions.js'
import type { RunId, RunStatus, SerializedError, StepId, StepKind } from './types.js'

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
  | {
      type: 'backend.fallback'
      runId: RunId
      stepId: string
      from: string
      to: string
      reason: string
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
 */
export class EventBus {
  private readonly listeners: Set<EventListener> = new Set()

  publish(event: RunEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        // Subscribers are expected to be infallible; if one throws, log and
        // continue. We do not let one bad subscriber poison the run.
        const detail = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[skelm event subscriber error] ${detail}\n`)
      }
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Filter helper: subscribe but only fire the listener for events whose
   * runId matches. Returns an unsubscribe function.
   */
  forRun(runId: RunId, listener: EventListener): () => void {
    return this.subscribe((event) => {
      if (event.runId === runId) listener(event)
    })
  }

  /** Number of active listeners; useful in tests. */
  get listenerCount(): number {
    return this.listeners.size
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
