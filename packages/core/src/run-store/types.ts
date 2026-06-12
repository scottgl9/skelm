import type { ArtifactDescriptor, ArtifactRef } from '../artifact-types.js'
import type { AuditEvent } from '../enforcement/audit-writer.js'
import type { RunEvent } from '../events.js'
import type { RunId, RunStatus, SerializedError, StepId, TaskStatus } from '../types-base.js'
import type { Run, StateEntry, StateReadOptions, StateSetOptions } from '../types.js'

export interface RunSummary {
  readonly runId: RunId
  readonly pipelineId: string
  /** Absolute path to the workflow file, when known. */
  readonly workflowPath?: string
  /** Trigger id, when this run was started by a gateway-managed trigger. */
  readonly triggerId?: string
  readonly status: RunStatus
  readonly startedAt: number
  readonly completedAt?: number
}

/**
 * Patch shape for `updateRun`. Mirrors `Partial<Run>` but allows explicit
 * `undefined` to clear an optional field (the `waiting` snapshot is set
 * while a run parks at wait() and cleared on resume). Plain `Partial<Run>`
 * with `exactOptionalPropertyTypes: true` rejects `{ waiting: undefined }`.
 */
type OptionalKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T]
type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>
// Required Run fields stay strictly typed; optional Run fields accept
// explicit `undefined` to mean "clear".
export type RunPatch = {
  [K in RequiredKeys<Run>]?: Run[K]
} & { [K in OptionalKeys<Run>]?: Run[K] | undefined }

/**
 * Spread-equivalent that drops `undefined` values for required fields and
 * deletes optional fields whose patch entry is explicit `undefined`. Keeps
 * the result conformant with Run under `exactOptionalPropertyTypes: true`.
 */
export function applyRunPatch(existing: Run, patch: RunPatch): Run {
  const merged: Record<string, unknown> = { ...existing }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete merged[k]
    else merged[k] = v
  }
  return merged as unknown as Run
}

export interface RunFilter {
  readonly pipelineId?: string
  readonly status?: RunStatus
  /** Narrow to runs started by this trigger id. */
  readonly triggerId?: string
  readonly limit?: number
  /** Inclusive lower bound on `startedAt` (epoch ms). */
  readonly startedAfter?: number
  /** Inclusive upper bound on `startedAt` (epoch ms). */
  readonly startedBefore?: number
}

export interface AuditEntry {
  readonly runId?: RunId
  readonly actor: string
  readonly action: string
  readonly data: unknown
  readonly at: number
}

export interface AuditFilter {
  readonly runId?: RunId
  readonly actor?: string
  readonly action?: string
  /** Inclusive lower bound on writer timestamp (ISO-8601). */
  readonly since?: string
  /** Inclusive upper bound on writer timestamp (ISO-8601). */
  readonly until?: string
  readonly limit?: number
  /**
   * Exclusive upper bound on sequence number — return only entries with
   * `seq < before`. Cursor for backwards paging: pass the lowest `seq` from
   * the previous page to fetch the next-older page.
   */
  readonly before?: number
}

export interface AuditLogReader<TEntry extends AuditEvent = AuditEvent> {
  list(filter?: AuditFilter): Promise<readonly TEntry[]>
  verify?(): Promise<{ seq: number; reason: string } | null>
}

export interface WorkflowStateStore {
  getState<T>(namespace: string, key: string): Promise<T | undefined>
  setState<T>(namespace: string, key: string, value: T, opts?: StateSetOptions): Promise<void>
  deleteState(namespace: string, key: string): Promise<void>
  listState(namespace: string, prefix?: string): AsyncIterable<StateEntry>
  casState<T>(namespace: string, key: string, expected: T | undefined, next: T): Promise<boolean>
  appendState(namespace: string, stream: string, entry: unknown): Promise<void>
  readState(namespace: string, stream: string, opts?: StateReadOptions): AsyncIterable<unknown>
}

export interface AgentMemoryRecord {
  readonly id: string
  readonly scope: string
  readonly content: unknown
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly createdAt: number
  readonly updatedAt: number
}

export interface DurableAgentMemory {
  put(record: AgentMemoryRecord): Promise<void>
  get(id: string): Promise<AgentMemoryRecord | null>
  query(opts?: {
    readonly scope?: string
    readonly text?: string
    readonly limit?: number
  }): AsyncIterable<AgentMemoryRecord>
  delete(id: string): Promise<boolean>
}

// Artifact handle shapes live in a leaf module to keep types.ts from
// inline-importing this file (which would close a types ↔ run-store
// cycle). Re-exported here for back-compat.
export {
  ArtifactMaterializationError,
  ArtifactValidationError,
} from '../artifact-types.js'
export type {
  ArtifactDescriptor,
  ArtifactMaterialization,
  ArtifactMaterializeOptions,
  ArtifactRef,
  ArtifactStoreHandle,
} from '../artifact-types.js'

/** Raised by `putArtifact` when adding an artifact would exceed the per-run quota. */
export class ArtifactQuotaExceededError extends Error {
  override readonly name = 'ArtifactQuotaExceededError'
  constructor(
    readonly runId: RunId,
    readonly limitBytes: number,
    readonly attemptedBytes: number,
  ) {
    super(
      `artifact quota exceeded for run ${runId}: would write ${attemptedBytes} bytes, limit ${limitBytes} bytes`,
    )
  }
}

/** Persistence of binary artifacts (e.g. screenshots, evidence) by run + step. */
export interface ArtifactStore {
  putArtifact(opts: {
    runId: RunId
    stepId?: string
    name: string
    mimeType: string
    data: Uint8Array | string
  }): Promise<ArtifactDescriptor>
  getArtifact(
    ref: ArtifactRef,
  ): Promise<{ descriptor: ArtifactDescriptor; data: Uint8Array } | null>
  listArtifacts(runId: RunId, opts?: { stepId?: string }): AsyncIterable<ArtifactDescriptor>
}

/**
 * Where a completed task's result should be delivered. Minimal opaque contract
 * for now — `kind` names a channel (e.g. `slack`, `webhook`) and `target` is
 * the channel-specific address. Recorded only in this phase; no dispatch is
 * performed against it. Richer conversation-adapter semantics arrive in a later
 * integration phase.
 *
 * @experimental shape may change before delivery dispatch lands.
 */
export interface DeliveryTarget {
  readonly kind: string
  readonly target: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * A detached task: a request to run a registered workflow whose lifecycle is
 * tracked independently of the child run it dispatches. Created via the gateway
 * tasks API; the child run executes through the normal run dispatch path with
 * its own declared permissions.
 */
export interface TaskRecord {
  readonly taskId: string
  readonly workflowId: string
  /** Child run dispatched for this task; absent until dispatch succeeds. */
  readonly childRunId?: RunId
  /** Parent run that requested the task, when started from within a run. */
  readonly parentRunId?: RunId
  /** Step within the parent run that requested the task, when known. */
  readonly parentStepId?: StepId
  /** Session correlation id supplied by the caller, when any. */
  readonly parentSessionId?: string
  readonly status: TaskStatus
  readonly input?: unknown
  /** Short human summary of the result, set on completion. */
  readonly summary?: string
  readonly deliveryTarget?: DeliveryTarget
  /** When this task is a retry, the id of the task it retries. */
  readonly retryOfTaskId?: string
  readonly createdAt: string
  readonly startedAt?: string
  readonly completedAt?: string
  readonly error?: SerializedError
}

/** Patch shape for `updateTask`; explicit `undefined` clears an optional field. */
export type TaskPatch = {
  [K in Exclude<keyof TaskRecord, 'taskId' | 'workflowId' | 'createdAt'>]?:
    | TaskRecord[K]
    | undefined
}

export interface TaskFilter {
  readonly status?: TaskStatus
  readonly parentRunId?: RunId
  readonly workflowId?: string
  readonly limit?: number
}

/** Spread-equivalent merge for {@link TaskPatch}; deletes keys set to `undefined`. */
export function applyTaskPatch(existing: TaskRecord, patch: TaskPatch): TaskRecord {
  const merged: Record<string, unknown> = { ...existing }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete merged[k]
    else merged[k] = v
  }
  return merged as unknown as TaskRecord
}

/** Persistence of detached tasks and their lineage to child runs. */
export interface TaskStore {
  putTask(task: TaskRecord): Promise<void>
  updateTask(taskId: string, patch: TaskPatch): Promise<void>
  getTask(taskId: string): Promise<TaskRecord | null>
  listTasks(filter?: TaskFilter): Promise<readonly TaskRecord[]>
}

/** Persistence of run lifecycle: run records, step events, and optional audit rows. */
export interface ExecutionStore {
  putRun(run: Run): Promise<void>
  updateRun(runId: RunId, patch: RunPatch): Promise<void>
  getRun(runId: RunId): Promise<Run | null>
  listRuns(filter?: RunFilter): AsyncIterable<RunSummary>
  appendEvent(event: RunEvent): Promise<void>
  listEvents(runId: RunId, opts?: { since?: number; limit?: number }): AsyncIterable<RunEvent>
  putAudit?(entry: AuditEntry): Promise<void>
}

/** Key-value, compare-and-swap, and append-log state accessible via ctx.state. */
export interface StateStore extends WorkflowStateStore {}

/** Combined store used by implementations that back both APIs with a single driver. */
export type RunStore = ExecutionStore & StateStore & ArtifactStore & TaskStore

/**
 * Default per-run artifact byte quota (256 MiB). Implementations may override
 * via constructor options. The limit is checked at putArtifact time; an
 * over-quota call rejects with `ArtifactQuotaExceededError` and writes nothing.
 */
export const DEFAULT_ARTIFACT_QUOTA_BYTES = 256 * 1024 * 1024

/**
 * Default caps for {@link MemoryRunStore}. The store is intended for
 * development, tests, and the embedded default in `runPipeline`; under a
 * long-running gateway it would otherwise grow without bound. Production
 * deployments should use {@link PostgresRunStore} or {@link SqliteRunStore}.
 */
export const DEFAULT_MAX_RUNS_IN_MEMORY = 10_000
export const DEFAULT_MAX_EVENTS_PER_RUN_IN_MEMORY = 50_000
export const DEFAULT_MAX_AUDIT_ENTRIES_IN_MEMORY = 100_000

export function listRunsCompat(items: readonly RunSummary[]): AsyncIterable<RunSummary> {
  return {
    get length() {
      return items.length
    },
    async *[Symbol.asyncIterator]() {
      yield* items
    },
  } as AsyncIterable<RunSummary>
}
