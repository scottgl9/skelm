import { validateArtifactMetadata } from '../artifact-types.js'
import type { ArtifactDescriptor, ArtifactRef } from '../artifact-types.js'
import type { RunEvent } from '../events.js'
import type { RunId } from '../types-base.js'
import type { Run, StateEntry, StateReadOptions, StateSetOptions } from '../types.js'
import {
  ArtifactQuotaExceededError,
  DEFAULT_ARTIFACT_QUOTA_BYTES,
  DEFAULT_MAX_AUDIT_ENTRIES_IN_MEMORY,
  DEFAULT_MAX_EVENTS_PER_RUN_IN_MEMORY,
  DEFAULT_MAX_RUNS_IN_MEMORY,
  applyRunPatch,
  applyTaskPatch,
  listRunsCompat,
} from './types.js'
import type {
  AuditEntry,
  RunFilter,
  RunPatch,
  RunStore,
  RunSummary,
  TaskFilter,
  TaskPatch,
  TaskRecord,
} from './types.js'

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) return true
  if (left === undefined || right === undefined) return false
  return JSON.stringify(left) === JSON.stringify(right)
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
  private readonly tasks = new Map<string, TaskRecord>()
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
    if (existing === undefined) return
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

  async putTask(task: TaskRecord): Promise<void> {
    this.tasks.set(task.taskId, task)
  }

  async updateTask(taskId: string, patch: TaskPatch): Promise<void> {
    const existing = this.tasks.get(taskId)
    if (existing === undefined) return
    this.tasks.set(taskId, applyTaskPatch(existing, patch))
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    return this.tasks.get(taskId) ?? null
  }

  async listTasks(filter: TaskFilter = {}): Promise<readonly TaskRecord[]> {
    const matches: TaskRecord[] = []
    for (const task of this.tasks.values()) {
      if (filter.status !== undefined && task.status !== filter.status) continue
      if (filter.parentRunId !== undefined && task.parentRunId !== filter.parentRunId) continue
      if (filter.workflowId !== undefined && task.workflowId !== filter.workflowId) continue
      matches.push(task)
    }
    matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return filter.limit === undefined ? matches : matches.slice(0, filter.limit)
  }

  async putArtifact(opts: {
    runId: RunId
    stepId?: string
    name: string
    mimeType: string
    data: Uint8Array | string
  }): Promise<ArtifactDescriptor> {
    validateArtifactMetadata(opts)
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
