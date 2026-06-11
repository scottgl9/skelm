import { randomUUID } from 'node:crypto'

import { Pool, type PoolClient } from 'pg'

import { validateArtifactMetadata } from './artifact-types.js'
import type { RunEvent } from './events.js'
import {
  type ArtifactDescriptor,
  ArtifactQuotaExceededError,
  type ArtifactRef,
  type AuditEntry,
  DEFAULT_ARTIFACT_QUOTA_BYTES,
  type RunFilter,
  type RunPatch,
  type RunStore,
  type RunSummary,
} from './run-store.js'
import type { RunStatus } from './types-base.js'
import type { Run, RunId, StateEntry, StateReadOptions, StateSetOptions } from './types.js'

export interface PostgresRunStoreOptions {
  /** Connection URL, e.g. postgres://user:pass@host:5432/db. */
  readonly url: string
  /** Optional schema name for `runs`, `events`, `state_*`, and `artifacts`. */
  readonly schema?: string
  /** Optional pool size hint (`pg.Pool` default is 10). */
  readonly poolSize?: number
  /** Optional per-run artifact byte quota override. */
  readonly artifactQuotaBytes?: number
}

const POSTGRES_MIN_VERSION = 15_0000

/**
 * Backward-compatible compatibility type while the Postgres path transitions
 * from seam to production implementation.
 */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError'
  constructor(method: string) {
    super(`PostgresRunStore.${method}() is not implemented`)
  }
}

/**
 * Postgres-backed {@link RunStore} for production deployments that need shared,
 * crash-safe durable state.
 */
export class PostgresRunStore implements RunStore {
  private readonly pool: Pool
  private readonly schema: string
  private readonly sqlSchema: string
  private readonly artifactQuotaBytes: number
  private readonly ready: Promise<void>
  private artifactCounter = 0

  constructor(readonly options: PostgresRunStoreOptions) {
    this.schema = normalizeSchema(options.schema ?? 'public')
    this.sqlSchema = quoteIdent(this.schema)
    this.artifactQuotaBytes = options.artifactQuotaBytes ?? DEFAULT_ARTIFACT_QUOTA_BYTES
    this.pool = new Pool({
      connectionString: options.url,
      ...(options.poolSize !== undefined && { max: options.poolSize }),
    })
    this.ready = this.init()
  }

  async putRun(run: Run): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO ${this.table('runs')} (
          run_id,
          pipeline_id,
          workflow_path,
          trigger_id,
          status,
          input_json,
          steps_json,
          output_json,
          error_json,
          started_at,
          completed_at,
          waiting_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (run_id)
        DO UPDATE SET
          pipeline_id = EXCLUDED.pipeline_id,
          workflow_path = EXCLUDED.workflow_path,
          trigger_id = EXCLUDED.trigger_id,
          status = EXCLUDED.status,
          input_json = EXCLUDED.input_json,
          steps_json = EXCLUDED.steps_json,
          output_json = EXCLUDED.output_json,
          error_json = EXCLUDED.error_json,
          started_at = EXCLUDED.started_at,
          completed_at = EXCLUDED.completed_at,
          waiting_json = EXCLUDED.waiting_json`,
        [
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
        ],
      )
    })
  }

  async updateRun(runId: RunId, patch: RunPatch): Promise<void> {
    await this.withTransaction(async (client) => {
      const row = await this.getRunRow(client, runId, true)
      if (row === undefined) return

      const existing = inflateRunRow(row)
      const next = applyRunPatch(existing, patch)
      await client.query(
        `INSERT INTO ${this.table('runs')} (
          run_id,
          pipeline_id,
          workflow_path,
          trigger_id,
          status,
          input_json,
          steps_json,
          output_json,
          error_json,
          started_at,
          completed_at,
          waiting_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (run_id)
        DO UPDATE SET
          pipeline_id = EXCLUDED.pipeline_id,
          workflow_path = EXCLUDED.workflow_path,
          trigger_id = EXCLUDED.trigger_id,
          status = EXCLUDED.status,
          input_json = EXCLUDED.input_json,
          steps_json = EXCLUDED.steps_json,
          output_json = EXCLUDED.output_json,
          error_json = EXCLUDED.error_json,
          started_at = EXCLUDED.started_at,
          completed_at = EXCLUDED.completed_at,
          waiting_json = EXCLUDED.waiting_json`,
        [
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
        ],
      )
    })
  }

  async getRun(runId: RunId): Promise<Run | null> {
    const run = await this.withClient(async (client) => {
      const row = await this.getRunRow(client, runId)
      return row === undefined ? null : inflateRunRow(row)
    })
    return run
  }

  async *listRuns(filter: RunFilter = {}): AsyncIterable<RunSummary> {
    const rows = await this.withClient((client) => this.queryRuns(client, filter))
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
    await this.withClient((client) =>
      client.query(
        `INSERT INTO ${this.table('events')} (run_id, type, payload_json, at)
         VALUES ($1, $2, $3, $4)`,
        [event.runId, event.type, encodeValue(event), event.at],
      ),
    )
  }

  async *listEvents(
    runId: RunId,
    opts: { since?: number; limit?: number } = {},
  ): AsyncIterable<RunEvent> {
    const rows = await this.withClient((client) =>
      this.queryEvents(client, runId, opts.since, opts.limit),
    )
    for (const row of rows) {
      yield decodeValue(row.payload_json)
    }
  }

  async getState<T>(namespace: string, key: string): Promise<T | undefined> {
    await this.withClient((client) => this.pruneExpiredState(client, namespace, key))
    const row = await this.withClient((client) =>
      client.query<{ value_json: string }>(
        `SELECT value_json
           FROM ${this.table('state_entries')}
          WHERE namespace = $1 AND key = $2`,
        [namespace, key],
      ),
    )
    if (row.rowCount === 0) return undefined
    const record = row.rows[0]
    if (record === undefined) return undefined
    return decodeValue<T>(record.value_json)
  }

  async setState<T>(
    namespace: string,
    key: string,
    value: T,
    opts: StateSetOptions = {},
  ): Promise<void> {
    const now = Date.now()
    const expires = expiresAt(opts, now)
    await this.withClient((client) =>
      client.query(
        `INSERT INTO ${this.table('state_entries')} (namespace, key, value_json, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (namespace, key)
         DO UPDATE SET
           value_json = EXCLUDED.value_json,
           expires_at = EXCLUDED.expires_at,
           updated_at = EXCLUDED.updated_at`,
        [namespace, key, encodeValue(value), expires, now],
      ),
    )
  }

  async deleteState(namespace: string, key: string): Promise<void> {
    await this.withClient((client) =>
      client.query(
        `DELETE FROM ${this.table('state_entries')}
         WHERE namespace = $1 AND key = $2`,
        [namespace, key],
      ),
    )
  }

  async *listState(namespace: string, prefix?: string): AsyncIterable<StateEntry> {
    await this.withClient((client) => this.pruneExpiredState(client, namespace))
    const rows = await this.withClient((client) => {
      if (prefix === undefined) {
        return client.query<{ key: string; value_json: string }>(
          `SELECT key, value_json
           FROM ${this.table('state_entries')}
           WHERE namespace = $1
           ORDER BY key ASC`,
          [namespace],
        )
      }
      const escaped = escapeLike(prefix)
      return client.query<{ key: string; value_json: string }>(
        `SELECT key, value_json
         FROM ${this.table('state_entries')}
         WHERE namespace = $1 AND key LIKE $2 ESCAPE '\\'
         ORDER BY key ASC`,
        [namespace, `${escaped}%`],
      )
    })

    for (const row of rows.rows) {
      yield { key: row.key, value: decodeValue(row.value_json) }
    }
  }

  async casState<T>(
    namespace: string,
    key: string,
    expected: T | undefined,
    next: T,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      await this.lockStateKey(client, namespace, key)
      await this.pruneExpiredState(client, namespace, key)
      const current = await client.query<{ value_json: string }>(
        `SELECT value_json
         FROM ${this.table('state_entries')}
         WHERE namespace = $1 AND key = $2
         FOR UPDATE`,
        [namespace, key],
      )
      const currentRecord = current.rows[0]
      if (current.rowCount === 0 || currentRecord === undefined) {
        if (expected !== undefined) {
          return false
        }
        const now = Date.now()
        await client.query(
          `INSERT INTO ${this.table('state_entries')} (namespace, key, value_json, expires_at, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (namespace, key)
           DO UPDATE SET
             value_json = EXCLUDED.value_json,
             expires_at = EXCLUDED.expires_at,
             updated_at = EXCLUDED.updated_at`,
          [namespace, key, encodeValue(next), null, now],
        )
        return true
      }
      const currentValue: T | undefined = decodeValue(currentRecord.value_json)
      if (!valuesEqual(currentValue, expected)) return false
      const now = Date.now()
      await client.query(
        `INSERT INTO ${this.table('state_entries')} (namespace, key, value_json, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (namespace, key)
         DO UPDATE SET
           value_json = EXCLUDED.value_json,
           expires_at = EXCLUDED.expires_at,
           updated_at = EXCLUDED.updated_at`,
        [namespace, key, encodeValue(next), null, now],
      )
      return true
    })
  }

  async appendState(namespace: string, stream: string, entry: unknown): Promise<void> {
    await this.withClient((client) =>
      client.query(
        `INSERT INTO ${this.table('state_journal')} (namespace, stream, entry_json, at)
         VALUES ($1, $2, $3, $4)`,
        [namespace, stream, encodeValue(entry), Date.now()],
      ),
    )
  }

  async *readState(
    namespace: string,
    stream: string,
    opts: StateReadOptions = {},
  ): AsyncIterable<unknown> {
    const params: Array<string | number> = [namespace, stream]
    const where: string[] = ['namespace = $1', 'stream = $2']
    let idx = 3

    if (opts.since !== undefined) {
      where.push(`at >= $${idx}`)
      params.push(opts.since)
      idx += 1
    }

    if (opts.limit !== undefined) {
      params.push(opts.limit)
    }

    const rows = await this.withClient((client) =>
      client.query<{ entry_json: string }>(
        `SELECT entry_json
         FROM ${this.table('state_journal')}
         WHERE ${where.join(' AND ')}
         ORDER BY at ASC, id ASC ${opts.limit === undefined ? '' : `LIMIT $${idx}`}`,
        params,
      ),
    )

    for (const row of rows.rows) {
      yield decodeValue(row.entry_json)
    }
  }

  async putAudit(entry: AuditEntry): Promise<void> {
    await this.withClient((client) =>
      client.query(
        `INSERT INTO ${this.table('audit')} (run_id, actor, action, data_json, at)
         VALUES ($1, $2, $3, $4, $5)`,
        [entry.runId ?? null, entry.actor, entry.action, encodeValue(entry.data), entry.at],
      ),
    )
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
      typeof opts.data === 'string' ? Buffer.from(opts.data, 'utf8') : Buffer.from(opts.data)
    this.artifactCounter += 1
    const artifactId = `art_${Date.now().toString(36)}_${this.artifactCounter.toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const createdAt = Date.now()

    return this.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`artifact:${opts.runId}`])
      const row = await client.query<{ used: string }>(
        `SELECT COALESCE(SUM(size), 0) AS used
         FROM ${this.table('artifacts')}
         WHERE run_id = $1`,
        [opts.runId],
      )
      const used = toNumber(row.rows[0]?.used)
      if (used + bytes.byteLength > this.artifactQuotaBytes) {
        throw new ArtifactQuotaExceededError(
          opts.runId,
          this.artifactQuotaBytes,
          used + bytes.byteLength,
        )
      }

      await client.query(
        `INSERT INTO ${this.table('artifacts')} (artifact_id, run_id, step_id, name, mime_type, data, size, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          artifactId,
          opts.runId,
          opts.stepId ?? null,
          opts.name,
          opts.mimeType,
          bytes,
          bytes.byteLength,
          createdAt,
        ],
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
    })
  }

  async getArtifact(
    ref: ArtifactRef,
  ): Promise<{ descriptor: ArtifactDescriptor; data: Uint8Array } | null> {
    const row = await this.withClient((client) =>
      client.query<{
        artifact_id: string
        run_id: string
        step_id: string | null
        name: string
        mime_type: string
        data: Buffer
        size: number
        created_at: number
      }>(
        `SELECT artifact_id, run_id, step_id, name, mime_type, data, size, created_at
         FROM ${this.table('artifacts')}
         WHERE run_id = $1 AND artifact_id = $2`,
        [ref.runId, ref.artifactId],
      ),
    )

    if (row.rowCount === 0) return null
    const record = row.rows[0]
    if (record === undefined) return null
    return {
      descriptor: {
        runId: record.run_id,
        artifactId: record.artifact_id,
        ...(record.step_id !== null && { stepId: record.step_id }),
        name: record.name,
        mimeType: record.mime_type,
        size: record.size,
        createdAt: toNumber(record.created_at),
      },
      data: new Uint8Array(record.data),
    }
  }

  async *listArtifacts(
    runId: RunId,
    opts: { stepId?: string } = {},
  ): AsyncIterable<ArtifactDescriptor> {
    const rows = await this.withClient((client) => {
      if (opts.stepId === undefined) {
        return client.query<{
          artifact_id: string
          run_id: string
          step_id: string | null
          name: string
          mime_type: string
          size: number
          created_at: number
        }>(
          `SELECT artifact_id, run_id, step_id, name, mime_type, size, created_at
           FROM ${this.table('artifacts')}
           WHERE run_id = $1
           ORDER BY created_at ASC, artifact_id ASC`,
          [runId],
        )
      }
      return client.query<{
        artifact_id: string
        run_id: string
        step_id: string | null
        name: string
        mime_type: string
        size: number
        created_at: number
      }>(
        `SELECT artifact_id, run_id, step_id, name, mime_type, size, created_at
         FROM ${this.table('artifacts')}
         WHERE run_id = $1 AND step_id = $2
         ORDER BY created_at ASC, artifact_id ASC`,
        [runId, opts.stepId],
      )
    })

    for (const row of rows.rows) {
      yield {
        runId: row.run_id,
        artifactId: row.artifact_id,
        ...(row.step_id !== null && { stepId: row.step_id }),
        name: row.name,
        mimeType: row.mime_type,
        size: row.size,
        createdAt: toNumber(row.created_at),
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ready
    const client = await this.pool.connect()
    try {
      return await fn(client)
    } finally {
      client.release()
    }
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query('BEGIN')
      try {
        const out = await fn(client)
        await client.query('COMMIT')
        return out
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    })
  }

  private async init(): Promise<void> {
    await this.withClient(async (client) => {
      const version = await client.query<{ server_version_num: string }>('SHOW server_version_num')
      const rawVersion = toNumber(version.rows[0]?.server_version_num?.trim())
      if (rawVersion < POSTGRES_MIN_VERSION) {
        throw new Error(
          `Postgres version ${rawVersion} is not supported; minimum is PostgreSQL 15 (>= 150000)`,
        )
      }
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.sqlSchema}`)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table('runs')} (
          run_id TEXT PRIMARY KEY,
          pipeline_id TEXT NOT NULL,
          workflow_path TEXT,
          trigger_id TEXT,
          status TEXT NOT NULL,
          input_json TEXT NOT NULL,
          steps_json TEXT NOT NULL,
          output_json TEXT,
          error_json TEXT,
          started_at BIGINT NOT NULL,
          completed_at BIGINT,
          waiting_json TEXT
        )
      `)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table('events')} (
          id BIGSERIAL PRIMARY KEY,
          run_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          at BIGINT NOT NULL
        )
      `)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table('audit')} (
          id BIGSERIAL PRIMARY KEY,
          run_id TEXT,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          data_json TEXT NOT NULL,
          at BIGINT NOT NULL
        )
      `)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table('state_entries')} (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          expires_at BIGINT,
          updated_at BIGINT NOT NULL,
          PRIMARY KEY (namespace, key)
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS state_entries_namespace_idx
          ON ${this.table('state_entries')} (namespace, key)
      `)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table('state_journal')} (
          id BIGSERIAL PRIMARY KEY,
          namespace TEXT NOT NULL,
          stream TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          at BIGINT NOT NULL
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS state_journal_namespace_idx
          ON ${this.table('state_journal')} (namespace, stream, at, id)
      `)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table('artifacts')} (
          artifact_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          step_id TEXT,
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          data BYTEA NOT NULL,
          size INTEGER NOT NULL,
          created_at BIGINT NOT NULL
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS artifacts_run_idx
          ON ${this.table('artifacts')} (run_id, step_id, created_at, artifact_id)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS events_run_idx
          ON ${this.table('events')} (run_id, at, id)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS runs_started_at_idx
          ON ${this.table('runs')} (started_at)
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS runs_status_idx
          ON ${this.table('runs')} (status, started_at)
      `)

      const cols = await client.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'runs'`,
        [this.schema],
      )
      const hasColumn = new Set(cols.rows.map((row) => row.column_name))

      const alterStatements: string[] = []
      if (!hasColumn.has('workflow_path')) {
        alterStatements.push(`ALTER TABLE ${this.table('runs')} ADD COLUMN workflow_path TEXT`)
      }
      if (!hasColumn.has('trigger_id')) {
        alterStatements.push(`ALTER TABLE ${this.table('runs')} ADD COLUMN trigger_id TEXT`)
      }
      if (!hasColumn.has('waiting_json')) {
        alterStatements.push(`ALTER TABLE ${this.table('runs')} ADD COLUMN waiting_json TEXT`)
      }

      for (const statement of alterStatements) {
        await client.query(statement)
      }
    })
  }

  private table(name: string): string {
    return `${this.sqlSchema}.${quoteIdent(name)}`
  }

  private async getRunRow(
    client: PoolClient,
    runId: RunId,
    forUpdate = false,
  ): Promise<
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
  > {
    const where = forUpdate
      ? `SELECT run_id, pipeline_id, workflow_path, trigger_id, status, input_json, steps_json, output_json, error_json, started_at, completed_at, waiting_json
         FROM ${this.table('runs')}
         WHERE run_id = $1
         FOR UPDATE`
      : `SELECT run_id, pipeline_id, workflow_path, trigger_id, status, input_json, steps_json, output_json, error_json, started_at, completed_at, waiting_json
         FROM ${this.table('runs')}
         WHERE run_id = $1`
    const row = await client.query<{
      run_id: string
      pipeline_id: string
      workflow_path: string | null
      trigger_id: string | null
      status: RunStatus
      input_json: string
      steps_json: string
      output_json: string | null
      error_json: string | null
      started_at: number | string
      completed_at: number | string | null
      waiting_json: string | null
    }>(where, [runId])
    if (row.rowCount === 0) return undefined
    const record = row.rows[0]
    if (record === undefined) return undefined
    return {
      ...record,
      started_at: toNumber(record.started_at),
      completed_at: record.completed_at === null ? null : toNumber(record.completed_at),
    }
  }

  private async queryRuns(
    client: PoolClient,
    filter: RunFilter,
  ): Promise<
    Array<{
      run_id: string
      pipeline_id: string
      workflow_path: string | null
      trigger_id: string | null
      status: Run['status']
      started_at: number
      completed_at: number | null
    }>
  > {
    const clauses: string[] = []
    const params: unknown[] = []
    let idx = 1

    if (filter.pipelineId !== undefined) {
      clauses.push(`pipeline_id = $${idx}`)
      params.push(filter.pipelineId)
      idx += 1
    }
    if (filter.status !== undefined) {
      clauses.push(`status = $${idx}`)
      params.push(filter.status)
      idx += 1
    }
    if (filter.triggerId !== undefined) {
      clauses.push(`trigger_id = $${idx}`)
      params.push(filter.triggerId)
      idx += 1
    }
    if (filter.startedAfter !== undefined) {
      clauses.push(`started_at >= $${idx}`)
      params.push(filter.startedAfter)
      idx += 1
    }
    if (filter.startedBefore !== undefined) {
      clauses.push(`started_at <= $${idx}`)
      params.push(filter.startedBefore)
      idx += 1
    }

    if (filter.limit !== undefined) {
      params.push(filter.limit)
    }

    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const query = `
      SELECT run_id, pipeline_id, workflow_path, trigger_id, status, started_at, completed_at
      FROM ${this.table('runs')}
      ${where}
      ORDER BY started_at DESC ${filter.limit === undefined ? '' : `LIMIT $${idx}`}
    `
    const rows = await client.query<{
      run_id: string
      pipeline_id: string
      workflow_path: string | null
      trigger_id: string | null
      status: Run['status']
      started_at: number | string
      completed_at: number | string | null
    }>(query, params)

    return rows.rows.map((row) => ({
      ...row,
      started_at: toNumber(row.started_at),
      completed_at: row.completed_at === null ? null : toNumber(row.completed_at),
    }))
  }

  private async queryEvents(
    client: PoolClient,
    runId: RunId,
    since?: number,
    limit?: number,
  ): Promise<
    Array<{
      payload_json: string
    }>
  > {
    const clauses = ['run_id = $1']
    const params: unknown[] = [runId]
    let idx = 2

    if (since !== undefined) {
      clauses.push(`at >= $${idx}`)
      params.push(since)
      idx += 1
    }
    const sql = `
      SELECT payload_json
      FROM ${this.table('events')}
      WHERE ${clauses.join(' AND ')}
      ORDER BY at ASC, COALESCE((payload_json::jsonb->'value'->>'seq')::BIGINT, id) ASC, id ASC ${limit === undefined ? '' : `LIMIT $${idx}`}
    `
    if (limit !== undefined) {
      params.push(limit)
    }

    const rows = await client.query<{ payload_json: string }>(sql, params)
    return rows.rows
  }

  private async pruneExpiredState(
    client: PoolClient,
    namespace: string,
    key?: string,
  ): Promise<void> {
    const now = Date.now()
    if (key === undefined) {
      await client.query(
        `DELETE FROM ${this.table('state_entries')}
         WHERE namespace = $1 AND expires_at IS NOT NULL AND expires_at <= $2`,
        [namespace, now],
      )
      return
    }

    await client.query(
      `DELETE FROM ${this.table('state_entries')}
       WHERE namespace = $1 AND key = $2 AND expires_at IS NOT NULL AND expires_at <= $3`,
      [namespace, key, now],
    )
  }

  private async lockStateKey(client: PoolClient, namespace: string, key: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [namespace, key])
  }
}

function normalizeSchema(schema: string): string {
  const trimmed = schema.trim()
  return trimmed.length === 0 ? 'public' : trimmed
}

function quoteIdent(raw: string): string {
  return `"${raw.replaceAll('"', '""')}"`
}

function encodeValue(value: unknown): string {
  return JSON.stringify(value === undefined ? { __skelmUndefined: true } : { value })
}

function decodeValue<T>(value: string): T {
  const parsed = JSON.parse(value) as { __skelmUndefined?: boolean; value?: T }
  return parsed.__skelmUndefined === true ? (undefined as T) : (parsed.value as T)
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null) return left === right
  if (typeof left !== typeof right) return false
  if (typeof left !== 'object') return false

  if (left instanceof Date || right instanceof Date) {
    return false
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i += 1) {
      if (!valuesEqual(left[i], right[i])) return false
    }
    return true
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>

  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  if (leftKeys.length !== rightKeys.length) return false

  for (let i = 0; i < leftKeys.length; i += 1) {
    const key = leftKeys[i]
    const rightKey = rightKeys[i]
    if (key === undefined || rightKey === undefined) return false
    if (key !== rightKey) return false
    if (!valuesEqual(leftRecord[key], rightRecord[key])) return false
  }

  return true
}

function applyRunPatch(existing: Run, patch: RunPatch): Run {
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete merged[key]
    } else {
      merged[key] = value
    }
  }
  return merged as unknown as Run
}

function decodeNullableValue<T>(value: string | null): T | undefined {
  return value === null ? undefined : decodeValue<T>(value)
}

function inflateRunRow(row: {
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

function expiresAt(opts: StateSetOptions, now: number): number | null {
  return opts.ttlMs === undefined ? null : now + opts.ttlMs
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function toNumber(value: number | string | undefined): number {
  if (typeof value === 'number') return value
  if (value === undefined || value === null || value === '') return 0
  return Number(value)
}
