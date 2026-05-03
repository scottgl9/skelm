import Database from 'better-sqlite3'
import type { RunEvent } from './events.js'
import type { Run, RunId, RunStatus } from './types.js'

export interface RunSummary {
  readonly runId: RunId
  readonly pipelineId: string
  readonly status: RunStatus
  readonly startedAt: number
  readonly completedAt?: number
}

export interface RunFilter {
  readonly pipelineId?: string
  readonly status?: RunStatus
  readonly limit?: number
}

export interface AuditEntry {
  readonly runId?: RunId
  readonly actor: string
  readonly action: string
  readonly data: unknown
  readonly at: number
}

export interface RunStore {
  putRun(run: Run): Promise<void>
  updateRun(runId: RunId, patch: Partial<Run>): Promise<void>
  getRun(runId: RunId): Promise<Run | null>
  listRuns(filter?: RunFilter): AsyncIterable<RunSummary>
  appendEvent(event: RunEvent): Promise<void>
  listEvents(runId: RunId, opts?: { since?: number; limit?: number }): AsyncIterable<RunEvent>
  putAudit?(entry: AuditEntry): Promise<void>
}

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<RunId, Run>()
  private readonly events = new Map<RunId, RunEvent[]>()
  private readonly audit: AuditEntry[] = []

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
}

export interface SqliteRunStoreOptions {
  path?: string
}

export class SqliteRunStore implements RunStore {
  private readonly db: Database.Database

  constructor(opts: SqliteRunStoreOptions = {}) {
    this.db = new Database(opts.path ?? ':memory:')
    this.db.pragma('journal_mode = WAL')
    this.init()
  }

  async putRun(run: Run): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO runs (
          run_id, pipeline_id, status, input_json, steps_json, output_json, error_json, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          pipeline_id = excluded.pipeline_id,
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
        `SELECT run_id, pipeline_id, status, input_json, steps_json, output_json, error_json, started_at, completed_at
         FROM runs WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          run_id: string
          pipeline_id: string
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
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = filter.limit !== undefined ? `LIMIT ${filter.limit}` : ''
    const rows = this.db
      .prepare(
        `SELECT run_id, pipeline_id, status, started_at, completed_at
         FROM runs ${where}
         ORDER BY started_at DESC ${limit}`,
      )
      .all(...params) as Array<{
      run_id: string
      pipeline_id: string
      status: RunStatus
      started_at: number
      completed_at: number | null
    }>
    for (const row of rows) {
      yield {
        runId: row.run_id,
        pipelineId: row.pipeline_id,
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

  close(): void {
    this.db.close()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        pipeline_id TEXT NOT NULL,
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
    `)
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
