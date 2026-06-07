import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { RunEvent } from './events.js'
import type { RunId, RunStatus } from './types-base.js'
import type { Run, StateEntry, StateReadOptions, StateSetOptions } from './types.js'

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
function applyRunPatch(existing: Run, patch: RunPatch): Run {
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

// Artifact handle shapes live in a leaf module to keep types.ts from
// inline-importing this file (which would close a types ↔ run-store
// cycle). Re-exported here for back-compat.
export type { ArtifactRef, ArtifactDescriptor, ArtifactStoreHandle } from './artifact-types.js'
import type { ArtifactDescriptor, ArtifactRef } from './artifact-types.js'

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
export interface StateStore {
  getState<T>(namespace: string, key: string): Promise<T | undefined>
  setState<T>(namespace: string, key: string, value: T, opts?: StateSetOptions): Promise<void>
  deleteState(namespace: string, key: string): Promise<void>
  listState(namespace: string, prefix?: string): AsyncIterable<StateEntry>
  casState<T>(namespace: string, key: string, expected: T | undefined, next: T): Promise<boolean>
  appendState(namespace: string, stream: string, entry: unknown): Promise<void>
  readState(namespace: string, stream: string, opts?: StateReadOptions): AsyncIterable<unknown>
}

/** Combined store used by implementations that back both APIs with a single driver. */
export type RunStore = ExecutionStore & StateStore & ArtifactStore

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

function listRunsCompat(items: readonly RunSummary[]): AsyncIterable<RunSummary> {
  return {
    get length() {
      return items.length
    },
    async *[Symbol.asyncIterator]() {
      yield* items
    },
  } as AsyncIterable<RunSummary>
}

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<RunId, Run>()
  private readonly events = new Map<RunId, RunEvent[]>()
  private readonly audit: AuditEntry[] = []
  private readonly state = new Map<
    string,
    Map<string, { value: unknown; expiresAt?: number; updatedAt: number }>
  >()
  private readonly journals = new Map<string, Map<string, Array<{ entry: unknown; at: number }>>>()
  private readonly artifacts = new Map<RunId, Array<ArtifactDescriptor & { data: Uint8Array }>>()
  private artifactCounter = 0
  private readonly artifactQuotaBytes: number
  private readonly maxRuns: number
  private readonly maxEventsPerRun: number
  private readonly maxAuditEntries: number

  constructor(
    opts: {
      artifactQuotaBytes?: number
      /** Cap on total Run records retained. Oldest-by-startedAt evicted
       *  when exceeded. Default: 10_000. */
      maxRuns?: number
      /** Cap on events kept per run. Oldest dropped when exceeded.
       *  Default: 50_000. */
      maxEventsPerRun?: number
      /** Cap on audit entries retained. Oldest dropped when exceeded.
       *  Default: 100_000. */
      maxAuditEntries?: number
    } = {},
  ) {
    this.artifactQuotaBytes = opts.artifactQuotaBytes ?? DEFAULT_ARTIFACT_QUOTA_BYTES
    this.maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS_IN_MEMORY
    this.maxEventsPerRun = opts.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN_IN_MEMORY
    this.maxAuditEntries = opts.maxAuditEntries ?? DEFAULT_MAX_AUDIT_ENTRIES_IN_MEMORY
  }

  async putRun(run: Run): Promise<void> {
    this.runs.set(run.runId, run)
    if (this.runs.size > this.maxRuns) this.evictOldestRun()
  }

  /**
   * Evict the oldest run (by startedAt) along with its events and
   * artifacts. Called after putRun exceeds the cap to prevent unbounded
   * growth under a long-running gateway using the in-memory store.
   */
  private evictOldestRun(): void {
    let oldestId: RunId | undefined
    let oldestStarted = Number.POSITIVE_INFINITY
    for (const run of this.runs.values()) {
      if (run.startedAt < oldestStarted) {
        oldestStarted = run.startedAt
        oldestId = run.runId
      }
    }
    if (oldestId !== undefined) {
      this.runs.delete(oldestId)
      this.events.delete(oldestId)
      this.artifacts.delete(oldestId)
    }
  }

  async updateRun(runId: RunId, patch: RunPatch): Promise<void> {
    const existing = this.runs.get(runId)
    if (!existing) return
    this.runs.set(runId, applyRunPatch(existing, patch))
  }

  async getRun(runId: RunId): Promise<Run | null> {
    return this.runs.get(runId) ?? null
  }

  listRuns(filter: RunFilter = {}): AsyncIterable<RunSummary> {
    // Single-pass filter avoids four intermediate-array allocations on
    // the hot list path. The sort is unavoidable without an index.
    const matches: Run[] = []
    for (const run of this.runs.values()) {
      if (filter.pipelineId !== undefined && run.pipelineId !== filter.pipelineId) continue
      if (filter.status !== undefined && run.status !== filter.status) continue
      if (filter.triggerId !== undefined && run.triggerId !== filter.triggerId) continue
      if (filter.startedAfter !== undefined && run.startedAt < filter.startedAfter) continue
      if (filter.startedBefore !== undefined && run.startedAt > filter.startedBefore) continue
      matches.push(run)
    }
    matches.sort((a, b) => b.startedAt - a.startedAt)
    const limited = filter.limit === undefined ? matches : matches.slice(0, filter.limit)
    const summaries = limited.map((run) => ({
      runId: run.runId,
      pipelineId: run.pipelineId,
      ...(run.workflowPath !== undefined && { workflowPath: run.workflowPath }),
      ...(run.triggerId !== undefined && { triggerId: run.triggerId }),
      status: run.status,
      startedAt: run.startedAt,
      ...(run.completedAt !== undefined && { completedAt: run.completedAt }),
    }))
    return listRunsCompat(summaries)
  }

  async *listEvents(
    runId: RunId,
    opts: { since?: number; limit?: number } = {},
  ): AsyncIterable<RunEvent> {
    const all = this.events.get(runId) ?? []
    const since = opts.since ?? 0
    const limit = opts.limit
    let emitted = 0
    for (const event of all) {
      if (event.at < since) continue
      if (limit !== undefined && emitted >= limit) break
      emitted++
      yield event
    }
  }

  async putAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(entry)
    if (this.audit.length > this.maxAuditEntries) {
      this.audit.splice(0, this.audit.length - this.maxAuditEntries)
    }
  }

  async appendEvent(event: RunEvent): Promise<void> {
    const current = this.events.get(event.runId) ?? []
    current.push(event)
    if (current.length > this.maxEventsPerRun) {
      // Drop the oldest event(s) so per-run memory stays bounded under
      // a long-running gateway. Newest events are the most useful for
      // tailing /stream and reconstructing a failed run.
      current.splice(0, current.length - this.maxEventsPerRun)
    }
    this.events.set(event.runId, current)
  }
  async getState<T>(namespace: string, key: string): Promise<T | undefined> {
    this.pruneExpiredState(namespace, key)
    return this.state.get(namespace)?.get(key)?.value as T | undefined
  }

  async setState<T>(
    namespace: string,
    key: string,
    value: T,
    opts: StateSetOptions = {},
  ): Promise<void> {
    const bucket = this.state.get(namespace) ?? new Map()
    bucket.set(key, {
      value,
      updatedAt: Date.now(),
      ...(opts.ttlMs !== undefined && { expiresAt: Date.now() + opts.ttlMs }),
    })
    this.state.set(namespace, bucket)
  }

  async deleteState(namespace: string, key: string): Promise<void> {
    this.state.get(namespace)?.delete(key)
  }

  async *listState(namespace: string, prefix?: string): AsyncIterable<StateEntry> {
    this.pruneExpiredState(namespace)
    const entries = [...(this.state.get(namespace)?.entries() ?? [])]
      .filter(([key]) => prefix === undefined || key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
    for (const [key, entry] of entries) {
      yield { key, value: entry.value }
    }
  }

  async casState<T>(
    namespace: string,
    key: string,
    expected: T | undefined,
    next: T,
  ): Promise<boolean> {
    this.pruneExpiredState(namespace, key)
    const current = this.state.get(namespace)?.get(key)?.value as T | undefined
    if (!valuesEqual(current, expected)) return false
    await this.setState(namespace, key, next)
    return true
  }

  async appendState(namespace: string, stream: string, entry: unknown): Promise<void> {
    const namespaceStreams = this.journals.get(namespace) ?? new Map()
    const streamEntries = namespaceStreams.get(stream) ?? []
    streamEntries.push({ entry, at: Date.now() })
    namespaceStreams.set(stream, streamEntries)
    this.journals.set(namespace, namespaceStreams)
  }

  async *readState(
    namespace: string,
    stream: string,
    opts: StateReadOptions = {},
  ): AsyncIterable<unknown> {
    const entries = (this.journals.get(namespace)?.get(stream) ?? [])
      .filter((entry) => opts.since === undefined || entry.at >= opts.since)
      .slice(0, opts.limit)
    for (const entry of entries) {
      yield entry.entry
    }
  }

  private pruneExpiredState(namespace: string, key?: string): void {
    const bucket = this.state.get(namespace)
    if (bucket === undefined) return
    const now = Date.now()
    if (key !== undefined) {
      const entry = bucket.get(key)
      if (entry?.expiresAt !== undefined && entry.expiresAt <= now) {
        bucket.delete(key)
      }
      return
    }
    for (const [entryKey, entry] of bucket.entries()) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        bucket.delete(entryKey)
      }
    }
  }

  async putArtifact(opts: {
    runId: RunId
    stepId?: string
    name: string
    mimeType: string
    data: Uint8Array | string
  }): Promise<ArtifactDescriptor> {
    const bytes =
      typeof opts.data === 'string'
        ? Buffer.from(opts.data, 'utf8')
        : Buffer.from(opts.data.buffer, opts.data.byteOffset, opts.data.byteLength)
    const bucket = this.artifacts.get(opts.runId) ?? []
    const used = bucket.reduce((sum, a) => sum + a.size, 0)
    if (used + bytes.byteLength > this.artifactQuotaBytes) {
      throw new ArtifactQuotaExceededError(opts.runId, this.artifactQuotaBytes, bytes.byteLength)
    }
    this.artifactCounter += 1
    const descriptor: ArtifactDescriptor = {
      runId: opts.runId,
      artifactId: `art_${this.artifactCounter.toString(36)}`,
      ...(opts.stepId !== undefined && { stepId: opts.stepId }),
      name: opts.name,
      mimeType: opts.mimeType,
      size: bytes.byteLength,
      createdAt: Date.now(),
    }
    bucket.push({ ...descriptor, data: new Uint8Array(bytes) })
    this.artifacts.set(opts.runId, bucket)
    return descriptor
  }

  async getArtifact(
    ref: ArtifactRef,
  ): Promise<{ descriptor: ArtifactDescriptor; data: Uint8Array } | null> {
    const bucket = this.artifacts.get(ref.runId)
    if (bucket === undefined) return null
    const found = bucket.find((a) => a.artifactId === ref.artifactId)
    if (found === undefined) return null
    const { data, ...descriptor } = found
    return { descriptor, data: new Uint8Array(data) }
  }

  async *listArtifacts(
    runId: RunId,
    opts: { stepId?: string } = {},
  ): AsyncIterable<ArtifactDescriptor> {
    const bucket = this.artifacts.get(runId) ?? []
    for (const entry of bucket) {
      if (opts.stepId !== undefined && entry.stepId !== opts.stepId) continue
      const { data: _data, ...descriptor } = entry
      yield descriptor
    }
  }
}

export interface SqliteRunStoreOptions {
  path?: string
  artifactQuotaBytes?: number
}

export class SqliteRunStore implements RunStore {
  private readonly db: Database.Database
  private readonly artifactQuotaBytes: number
  private artifactCounter = 0

  constructor(opts: SqliteRunStoreOptions = {}) {
    const path = opts.path ?? ':memory:'
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true })
    }
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.artifactQuotaBytes = opts.artifactQuotaBytes ?? DEFAULT_ARTIFACT_QUOTA_BYTES
    this.init()
  }

  async putRun(run: Run): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO runs (
          run_id, pipeline_id, workflow_path, trigger_id, status, input_json, steps_json, output_json, error_json, started_at, completed_at, waiting_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          pipeline_id = excluded.pipeline_id,
          workflow_path = excluded.workflow_path,
          trigger_id = excluded.trigger_id,
          status = excluded.status,
          input_json = excluded.input_json,
          steps_json = excluded.steps_json,
          output_json = excluded.output_json,
          error_json = excluded.error_json,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          waiting_json = excluded.waiting_json`,
      )
      .run(
        run.runId,
        run.pipelineId,
        run.workflowPath ?? null,
        run.triggerId ?? null,
        run.status,
        encodeValue(run.input),
        encodeValue(run.steps),
        encodeValue(run.output),
        encodeValue(run.error),
        run.startedAt,
        run.completedAt ?? null,
        run.waiting !== undefined ? encodeValue(run.waiting) : null,
      )
  }

  async updateRun(runId: RunId, patch: RunPatch): Promise<void> {
    const existing = await this.getRun(runId)
    if (!existing) return
    await this.putRun(applyRunPatch(existing, patch))
  }

  async getRun(runId: RunId): Promise<Run | null> {
    const row = this.db
      .prepare(
        `SELECT run_id, pipeline_id, workflow_path, trigger_id, status, input_json, steps_json, output_json, error_json, started_at, completed_at, waiting_json
         FROM runs WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          run_id: string
          pipeline_id: string
          workflow_path: string | null
          trigger_id: string | null
          status: RunStatus
          input_json: string
          steps_json: string
          output_json: string | null
          error_json: string | null
          started_at: number
          completed_at: number | null
          waiting_json: string | null
        }
      | undefined
    if (!row) return null
    return {
      runId: row.run_id,
      pipelineId: row.pipeline_id,
      ...(row.workflow_path !== null && { workflowPath: row.workflow_path }),
      ...(row.trigger_id !== null && { triggerId: row.trigger_id }),
      status: row.status,
      input: decodeValue(row.input_json),
      steps: decodeValue(row.steps_json),
      output: decodeNullableValue(row.output_json),
      error: decodeNullableValue(row.error_json),
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      ...(row.waiting_json !== null && { waiting: decodeValue(row.waiting_json) }),
    }
  }

  async *listRuns(filter: RunFilter = {}): AsyncIterable<RunSummary> {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.pipelineId !== undefined) {
      clauses.push('pipeline_id = ?')
      params.push(filter.pipelineId)
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter.triggerId !== undefined) {
      clauses.push('trigger_id = ?')
      params.push(filter.triggerId)
    }
    if (filter.startedAfter !== undefined) {
      clauses.push('started_at >= ?')
      params.push(filter.startedAfter)
    }
    if (filter.startedBefore !== undefined) {
      clauses.push('started_at <= ?')
      params.push(filter.startedBefore)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = filter.limit !== undefined ? `LIMIT ${filter.limit}` : ''
    const rows = this.db
      .prepare(
        `SELECT run_id, pipeline_id, workflow_path, trigger_id, status, started_at, completed_at
         FROM runs ${where}
         ORDER BY started_at DESC ${limit}`,
      )
      .all(...params) as Array<{
      run_id: string
      pipeline_id: string
      workflow_path: string | null
      trigger_id: string | null
      status: RunStatus
      started_at: number
      completed_at: number | null
    }>
    for (const row of rows) {
      yield {
        runId: row.run_id,
        pipelineId: row.pipeline_id,
        ...(row.workflow_path !== null && { workflowPath: row.workflow_path }),
        ...(row.trigger_id !== null && { triggerId: row.trigger_id }),
        status: row.status,
        startedAt: row.started_at,
        ...(row.completed_at !== null && { completedAt: row.completed_at }),
      }
    }
  }

  async appendEvent(event: RunEvent): Promise<void> {
    this.db
      .prepare('INSERT INTO events (run_id, type, payload_json, at) VALUES (?, ?, ?, ?)')
      .run(event.runId, event.type, encodeValue(event), event.at)
  }

  async *listEvents(
    runId: RunId,
    opts: { since?: number; limit?: number } = {},
  ): AsyncIterable<RunEvent> {
    const clauses = ['run_id = ?']
    const params: unknown[] = [runId]
    if (opts.since !== undefined) {
      clauses.push('at >= ?')
      params.push(opts.since)
    }
    const limit = opts.limit !== undefined ? `LIMIT ${opts.limit}` : ''
    const rows = this.db
      .prepare(
        `SELECT payload_json
         FROM events
         WHERE ${clauses.join(' AND ')}
         ORDER BY at ASC, id ASC ${limit}`,
      )
      .all(...params) as Array<{ payload_json: string }>
    for (const row of rows) {
      yield decodeValue(row.payload_json)
    }
  }

  async putAudit(entry: AuditEntry): Promise<void> {
    this.db
      .prepare('INSERT INTO audit (run_id, actor, action, data_json, at) VALUES (?, ?, ?, ?, ?)')
      .run(entry.runId ?? null, entry.actor, entry.action, encodeValue(entry.data), entry.at)
  }

  async getState<T>(namespace: string, key: string): Promise<T | undefined> {
    this.pruneExpiredState(namespace, key)
    const row = this.db
      .prepare(
        `SELECT value_json
         FROM state_entries
         WHERE namespace = ? AND key = ?`,
      )
      .get(namespace, key) as { value_json: string } | undefined
    return row === undefined ? undefined : decodeValue<T>(row.value_json)
  }

  async setState<T>(
    namespace: string,
    key: string,
    value: T,
    opts: StateSetOptions = {},
  ): Promise<void> {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO state_entries (namespace, key, value_json, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET
           value_json = excluded.value_json,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(namespace, key, encodeValue(value), expiresAt(opts), now)
  }

  async deleteState(namespace: string, key: string): Promise<void> {
    this.db.prepare('DELETE FROM state_entries WHERE namespace = ? AND key = ?').run(namespace, key)
  }

  async *listState(namespace: string, prefix?: string): AsyncIterable<StateEntry> {
    this.pruneExpiredState(namespace)
    const clauses = ['namespace = ?']
    const params: unknown[] = [namespace]
    if (prefix !== undefined) {
      clauses.push('key LIKE ?')
      params.push(`${prefix}%`)
    }
    const rows = this.db
      .prepare(
        `SELECT key, value_json
         FROM state_entries
         WHERE ${clauses.join(' AND ')}
         ORDER BY key ASC`,
      )
      .all(...params) as Array<{ key: string; value_json: string }>
    for (const row of rows) {
      yield { key: row.key, value: decodeValue(row.value_json) }
    }
  }

  async casState<T>(
    namespace: string,
    key: string,
    expected: T | undefined,
    next: T,
  ): Promise<boolean> {
    const committed = this.db.transaction(() => {
      this.pruneExpiredState(namespace, key)
      const current = this.db
        .prepare(
          `SELECT value_json
           FROM state_entries
           WHERE namespace = ? AND key = ?`,
        )
        .get(namespace, key) as { value_json: string } | undefined
      const currentValue = current === undefined ? undefined : decodeValue<T>(current.value_json)
      if (!valuesEqual(currentValue, expected)) return false
      const now = Date.now()
      this.db
        .prepare(
          `INSERT INTO state_entries (namespace, key, value_json, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value_json = excluded.value_json,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
        )
        .run(namespace, key, encodeValue(next), null, now)
      return true
    })
    return committed()
  }

  async appendState(namespace: string, stream: string, entry: unknown): Promise<void> {
    this.db
      .prepare('INSERT INTO state_journal (namespace, stream, entry_json, at) VALUES (?, ?, ?, ?)')
      .run(namespace, stream, encodeValue(entry), Date.now())
  }

  async *readState(
    namespace: string,
    stream: string,
    opts: StateReadOptions = {},
  ): AsyncIterable<unknown> {
    const clauses = ['namespace = ?', 'stream = ?']
    const params: unknown[] = [namespace, stream]
    if (opts.since !== undefined) {
      clauses.push('at >= ?')
      params.push(opts.since)
    }
    const limit = opts.limit !== undefined ? `LIMIT ${opts.limit}` : ''
    const rows = this.db
      .prepare(
        `SELECT entry_json
         FROM state_journal
         WHERE ${clauses.join(' AND ')}
         ORDER BY at ASC, id ASC ${limit}`,
      )
      .all(...params) as Array<{ entry_json: string }>
    for (const row of rows) {
      yield decodeValue(row.entry_json)
    }
  }

  async putArtifact(opts: {
    runId: RunId
    stepId?: string
    name: string
    mimeType: string
    data: Uint8Array | string
  }): Promise<ArtifactDescriptor> {
    const bytes =
      typeof opts.data === 'string'
        ? Buffer.from(opts.data, 'utf8')
        : Buffer.from(opts.data.buffer, opts.data.byteOffset, opts.data.byteLength)
    const usedRow = this.db
      .prepare('SELECT COALESCE(SUM(size), 0) AS used FROM artifacts WHERE run_id = ?')
      .get(opts.runId) as { used: number } | undefined
    const used = usedRow?.used ?? 0
    if (used + bytes.byteLength > this.artifactQuotaBytes) {
      throw new ArtifactQuotaExceededError(opts.runId, this.artifactQuotaBytes, bytes.byteLength)
    }
    // Monotonic in-process counter avoids same-millisecond collisions; the
    // timestamp prefix keeps ids roughly sortable across process restarts.
    this.artifactCounter += 1
    const artifactId = `art_${Date.now().toString(36)}_${this.artifactCounter.toString(36)}`
    const createdAt = Date.now()
    this.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, run_id, step_id, name, mime_type, data, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifactId,
        opts.runId,
        opts.stepId ?? null,
        opts.name,
        opts.mimeType,
        bytes,
        bytes.byteLength,
        createdAt,
      )
    return {
      runId: opts.runId,
      artifactId,
      ...(opts.stepId !== undefined && { stepId: opts.stepId }),
      name: opts.name,
      mimeType: opts.mimeType,
      size: bytes.byteLength,
      createdAt,
    }
  }

  async getArtifact(
    ref: ArtifactRef,
  ): Promise<{ descriptor: ArtifactDescriptor; data: Uint8Array } | null> {
    const row = this.db
      .prepare(
        `SELECT artifact_id, run_id, step_id, name, mime_type, data, size, created_at
         FROM artifacts WHERE run_id = ? AND artifact_id = ?`,
      )
      .get(ref.runId, ref.artifactId) as
      | {
          artifact_id: string
          run_id: string
          step_id: string | null
          name: string
          mime_type: string
          data: Buffer
          size: number
          created_at: number
        }
      | undefined
    if (row === undefined) return null
    const descriptor: ArtifactDescriptor = {
      runId: row.run_id,
      artifactId: row.artifact_id,
      ...(row.step_id !== null && { stepId: row.step_id }),
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      createdAt: row.created_at,
    }
    return { descriptor, data: new Uint8Array(row.data) }
  }

  async *listArtifacts(
    runId: RunId,
    opts: { stepId?: string } = {},
  ): AsyncIterable<ArtifactDescriptor> {
    const clauses = ['run_id = ?']
    const params: unknown[] = [runId]
    if (opts.stepId !== undefined) {
      clauses.push('step_id = ?')
      params.push(opts.stepId)
    }
    const rows = this.db
      .prepare(
        `SELECT artifact_id, run_id, step_id, name, mime_type, size, created_at
         FROM artifacts
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at ASC, artifact_id ASC`,
      )
      .all(...params) as Array<{
      artifact_id: string
      run_id: string
      step_id: string | null
      name: string
      mime_type: string
      size: number
      created_at: number
    }>
    for (const row of rows) {
      yield {
        runId: row.run_id,
        artifactId: row.artifact_id,
        ...(row.step_id !== null && { stepId: row.step_id }),
        name: row.name,
        mimeType: row.mime_type,
        size: row.size,
        createdAt: row.created_at,
      }
    }
  }

  close(): void {
    this.db.close()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        pipeline_id TEXT NOT NULL,
        workflow_path TEXT,
        trigger_id TEXT,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        output_json TEXT,
        error_json TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        data_json TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state_entries (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(namespace, key)
      );
      CREATE INDEX IF NOT EXISTS state_entries_namespace_idx
        ON state_entries(namespace, key);
      CREATE TABLE IF NOT EXISTS state_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL,
        stream TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS state_journal_namespace_idx
        ON state_journal(namespace, stream, at, id);
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        data BLOB NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts(run_id, step_id, created_at, artifact_id);
      -- The events table is the fastest-growing, most-read table (SSE replay,
      -- GET /runs/:id/events, skelm history, crash recovery). listEvents is
      -- WHERE run_id = ? [AND at >= ?] ORDER BY at, id — index that exactly.
      CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, at, id);
      -- listRuns sorts by started_at DESC with optional time-range / status
      -- filters; recoverInterruptedRuns scans WHERE status = 'running'.
      CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs(started_at);
      CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status, started_at);
    `)
    // Migration: add columns added after initial schema. Idempotent — only
    // runs when the column is missing, so re-applies cleanly on every boot.
    const cols = this.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'workflow_path')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN workflow_path TEXT')
    }
    if (!cols.some((c) => c.name === 'trigger_id')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN trigger_id TEXT')
    }
    if (!cols.some((c) => c.name === 'waiting_json')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN waiting_json TEXT')
    }
  }

  private pruneExpiredState(namespace: string, key?: string): void {
    const clauses = ['namespace = ?', 'expires_at IS NOT NULL', 'expires_at <= ?']
    const params: unknown[] = [namespace, Date.now()]
    if (key !== undefined) {
      clauses.unshift('key = ?')
      params.unshift(key)
    }
    this.db.prepare(`DELETE FROM state_entries WHERE ${clauses.join(' AND ')}`).run(...params)
  }
}

function encodeValue(value: unknown): string {
  return JSON.stringify(value === undefined ? { __skelmUndefined: true } : { value })
}

function decodeValue<T>(value: string): T {
  const parsed = JSON.parse(value) as { __skelmUndefined?: boolean; value?: T }
  return parsed.__skelmUndefined === true ? (undefined as T) : (parsed.value as T)
}

function decodeNullableValue<T>(value: string | null): T | undefined {
  if (value === null) return undefined
  return decodeValue<T>(value)
}

function expiresAt(opts: StateSetOptions): number | null {
  return opts.ttlMs === undefined ? null : Date.now() + opts.ttlMs
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return encodeValue(left) === encodeValue(right)
}

export type { PostgresRunStoreOptions } from './run-store-postgres.js'
export { NotImplementedError, PostgresRunStore } from './run-store-postgres.js'
