import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { RunEvent } from './events.js'
import type {
  Run,
  RunId,
  RunStatus,
  StateEntry,
  StateReadOptions,
  StateSetOptions,
} from './types.js'

export interface RunSummary {
  readonly runId: RunId
  readonly pipelineId: string
  /** Absolute path to the workflow file, when known. */
  readonly workflowPath?: string
  readonly status: RunStatus
  readonly startedAt: number
  readonly completedAt?: number
}

export interface RunFilter {
  readonly pipelineId?: string
  readonly status?: RunStatus
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

/** Persistence of run lifecycle: run records, step events, and optional audit rows. */
export interface ExecutionStore {
  putRun(run: Run): Promise<void>
  updateRun(runId: RunId, patch: Partial<Run>): Promise<void>
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
export type RunStore = ExecutionStore & StateStore

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<RunId, Run>()
  private readonly events = new Map<RunId, RunEvent[]>()
  private readonly audit: AuditEntry[] = []
  private readonly state = new Map<
    string,
    Map<string, { value: unknown; expiresAt?: number; updatedAt: number }>
  >()
  private readonly journals = new Map<string, Map<string, Array<{ entry: unknown; at: number }>>>()

  async putRun(run: Run): Promise<void> {
    this.runs.set(run.runId, run)
  }

  async updateRun(runId: RunId, patch: Partial<Run>): Promise<void> {
    const existing = this.runs.get(runId)
    if (!existing) return
    this.runs.set(runId, { ...existing, ...patch })
  }

  async getRun(runId: RunId): Promise<Run | null> {
    return this.runs.get(runId) ?? null
  }

  async *listRuns(filter: RunFilter = {}): AsyncIterable<RunSummary> {
    const runs = [...this.runs.values()]
      .filter((run) => filter.pipelineId === undefined || run.pipelineId === filter.pipelineId)
      .filter((run) => filter.status === undefined || run.status === filter.status)
      .filter((run) => filter.startedAfter === undefined || run.startedAt >= filter.startedAfter)
      .filter((run) => filter.startedBefore === undefined || run.startedAt <= filter.startedBefore)
      .sort((a, b) => b.startedAt - a.startedAt)

    const limited = filter.limit === undefined ? runs : runs.slice(0, filter.limit)
    for (const run of limited) {
      yield {
        runId: run.runId,
        pipelineId: run.pipelineId,
        status: run.status,
        startedAt: run.startedAt,
        ...(run.completedAt !== undefined && { completedAt: run.completedAt }),
      }
    }
  }

  async appendEvent(event: RunEvent): Promise<void> {
    const current = this.events.get(event.runId) ?? []
    current.push(event)
    this.events.set(event.runId, current)
  }

  async *listEvents(
    runId: RunId,
    opts: { since?: number; limit?: number } = {},
  ): AsyncIterable<RunEvent> {
    const events = (this.events.get(runId) ?? [])
      .filter((event) => opts.since === undefined || event.at >= opts.since)
      .slice(0, opts.limit)
    for (const event of events) {
      yield event
    }
  }

  async putAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(entry)
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
}

export interface SqliteRunStoreOptions {
  path?: string
}

export class SqliteRunStore implements RunStore {
  private readonly db: Database.Database

  constructor(opts: SqliteRunStoreOptions = {}) {
    const path = opts.path ?? ':memory:'
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true })
    }
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.init()
  }

  async putRun(run: Run): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO runs (
          run_id, pipeline_id, workflow_path, status, input_json, steps_json, output_json, error_json, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          pipeline_id = excluded.pipeline_id,
          workflow_path = excluded.workflow_path,
          status = excluded.status,
          input_json = excluded.input_json,
          steps_json = excluded.steps_json,
          output_json = excluded.output_json,
          error_json = excluded.error_json,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at`,
      )
      .run(
        run.runId,
        run.pipelineId,
        run.workflowPath ?? null,
        run.status,
        encodeValue(run.input),
        encodeValue(run.steps),
        encodeValue(run.output),
        encodeValue(run.error),
        run.startedAt,
        run.completedAt ?? null,
      )
  }

  async updateRun(runId: RunId, patch: Partial<Run>): Promise<void> {
    const existing = await this.getRun(runId)
    if (!existing) return
    await this.putRun({ ...existing, ...patch })
  }

  async getRun(runId: RunId): Promise<Run | null> {
    const row = this.db
      .prepare(
        `SELECT run_id, pipeline_id, workflow_path, status, input_json, steps_json, output_json, error_json, started_at, completed_at
         FROM runs WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          run_id: string
          pipeline_id: string
          workflow_path: string | null
          status: RunStatus
          input_json: string
          steps_json: string
          output_json: string | null
          error_json: string | null
          started_at: number
          completed_at: number | null
        }
      | undefined
    if (!row) return null
    return {
      runId: row.run_id,
      pipelineId: row.pipeline_id,
      ...(row.workflow_path !== null && { workflowPath: row.workflow_path }),
      status: row.status,
      input: decodeValue(row.input_json),
      steps: decodeValue(row.steps_json),
      output: decodeNullableValue(row.output_json),
      error: decodeNullableValue(row.error_json),
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
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
        `SELECT run_id, pipeline_id, workflow_path, status, started_at, completed_at
         FROM runs ${where}
         ORDER BY started_at DESC ${limit}`,
      )
      .all(...params) as Array<{
      run_id: string
      pipeline_id: string
      workflow_path: string | null
      status: RunStatus
      started_at: number
      completed_at: number | null
    }>
    for (const row of rows) {
      yield {
        runId: row.run_id,
        pipelineId: row.pipeline_id,
        ...(row.workflow_path !== null && { workflowPath: row.workflow_path }),
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

  close(): void {
    this.db.close()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        pipeline_id TEXT NOT NULL,
        workflow_path TEXT,
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
    `)
    // Migration: add workflow_path column if it doesn't exist (added in v1.1)
    const cols = this.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'workflow_path')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN workflow_path TEXT')
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
