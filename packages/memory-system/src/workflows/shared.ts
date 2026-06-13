import type { Clock, MemoryRecord, MemorySystemDeps, WorkflowOutcome } from '../types.js'

/** A memory annotated with the durable-state metadata the workflows track. */
export interface TrackedMemory extends MemoryRecord {
  /** Last-seen timestamp recorded in state; absent until first observed. */
  readonly seenAt?: number
}

export function clockOf(deps: MemorySystemDeps): Clock {
  return deps.now ?? Date.now
}

export function logOf(deps: MemorySystemDeps, workflow: string) {
  return (message: string, data?: Readonly<Record<string, unknown>>): void => {
    deps.log?.({ workflow, message, ...(data !== undefined ? { data } : {}) })
  }
}

export function outcome(
  workflow: string,
  stats: Record<string, number>,
  denied?: readonly string[],
): WorkflowOutcome {
  return {
    workflow,
    ok: denied === undefined || denied.length === 0,
    stats,
    ...(denied !== undefined && denied.length > 0 ? { denied } : {}),
  }
}

/** State key under which a workflow records the last timestamp it saw a memory. */
export function seenKey(id: string): string {
  return `seen:${id}`
}
