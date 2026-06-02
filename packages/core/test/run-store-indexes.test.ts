import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SqliteRunStore } from '../src/run-store.js'

// The hottest read paths (event replay, listRuns, crash recovery) were
// full-scanning unindexed tables. Assert the migration creates the covering
// indexes by reading the on-disk schema from a second connection.
describe('SqliteRunStore schema indexes', () => {
  it('creates covering indexes for events and runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-idx-'))
    const path = join(dir, 'runs.db')
    // Constructor runs init() which creates the schema + indexes.
    const store = new SqliteRunStore({ path })

    const db = new Database(path, { readonly: true })
    const indexes = new Map(
      (
        db
          .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
          .all() as Array<{ name: string; sql: string }>
      ).map((r) => [r.name, r.sql]),
    )
    db.close()
    void store

    expect(indexes.has('events_run_idx')).toBe(true)
    expect(indexes.get('events_run_idx')).toContain('events')
    expect(indexes.get('events_run_idx')).toContain('run_id')

    expect(indexes.has('runs_started_at_idx')).toBe(true)
    expect(indexes.get('runs_started_at_idx')).toContain('started_at')

    expect(indexes.has('runs_status_idx')).toBe(true)
    expect(indexes.get('runs_status_idx')).toContain('status')
  })
})
