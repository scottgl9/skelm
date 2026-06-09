import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { validateArtifactMetadata } from '../artifact-types.js'
import type { ArtifactDescriptor, ArtifactRef } from '../artifact-types.js'
import type { RunEvent } from '../events.js'
import type { RunId, RunStatus } from '../types-base.js'
import type { Run, StateEntry, StateReadOptions, StateSetOptions } from '../types.js'
import { ArtifactQuotaExceededError, DEFAULT_ARTIFACT_QUOTA_BYTES, applyRunPatch } from './types.js'
import type { AuditEntry, RunFilter, RunPatch, RunStore, RunSummary } from './types.js'

// ── Codec helpers ─────────────────────────────────────────────────────────────
// Wrap values in a discriminated envelope so that `undefined` round-trips
// cleanly through the TEXT column (plain JSON.stringify drops undefined).

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

// ── SqliteRunStore ────────────────────────────────────────────────────────────

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
    const transaction = this.db.transaction(() => {
      const row = this.getRunRow(runId)
      if (row === undefined) return

      const existing = this.inflateRunRow(row)
      const next = applyRunPatch(existing, patch)
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
          next.runId,
          next.pipelineId,
          next.workflowPath ?? null,
          next.triggerId ?? null,
          next.status,
          encodeValue(next.input),
          encodeValue(next.steps),
          encodeValue(next.output),
          encodeValue(next.error),
          next.startedAt,
          next.completedAt ?? null,
          next.waiting !== undefined ? encodeValue(next.waiting) : null,
        )
    })
    transaction()
  }

  async getRun(runId: RunId): Promise<Run | null> {
    const row = this.getRunRow(runId)
    if (row === undefined) return null
    return this.inflateRunRow(row)
  }

  private getRunRow(runId: RunId):
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
    | undefined {
    return this.db
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
  }

  private inflateRunRow(row: {
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
  }): Run {
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
    validateArtifactMetadata(opts)
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
      -- WHERE run_id = ? [AND at >= ?] ORDER BY at, id -- index that exactly.
      CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, at, id);
      -- listRuns sorts by started_at DESC with optional time-range / status
      -- filters; recoverInterruptedRuns scans WHERE status = 'running'.
      CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs(started_at);
      CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status, started_at);
    `)
    // Migration: add columns added after initial schema. Idempotent -- only
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
