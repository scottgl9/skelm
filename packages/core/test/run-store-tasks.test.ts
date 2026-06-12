import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MemoryRunStore, SqliteRunStore } from '../src/run-store.js'
import type { RunStore, TaskRecord } from '../src/run-store.js'
import type { Run } from '../src/types.js'

function sampleTask(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    workflowId: 'wf-1',
    status: 'pending',
    input: { hello: 'world' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function sampleRun(runId: string, overrides: Partial<Run> = {}): Run {
  return {
    runId,
    pipelineId: 'p',
    status: 'completed',
    input: { ok: true },
    steps: [],
    output: { ok: true },
    error: undefined,
    startedAt: 1,
    completedAt: 2,
    ...overrides,
  }
}

function newSqlite(): SqliteRunStore {
  return new SqliteRunStore({ path: ':memory:' })
}

const drivers: Array<{ name: string; make: () => RunStore }> = [
  { name: 'MemoryRunStore', make: () => new MemoryRunStore() },
  { name: 'SqliteRunStore', make: () => newSqlite() },
]

for (const { name, make } of drivers) {
  describe(`${name} — task CRUD`, () => {
    it('puts and gets a task', async () => {
      const store = make()
      const task = sampleTask('t1')
      await store.putTask(task)
      await expect(store.getTask('t1')).resolves.toEqual(task)
    })

    it('returns null for an unknown task', async () => {
      const store = make()
      await expect(store.getTask('missing')).resolves.toBeNull()
    })

    it('roundtrips all optional fields including deliveryTarget and error', async () => {
      const store = make()
      const task = sampleTask('t2', {
        childRunId: 'run-c',
        parentRunId: 'run-p',
        parentStepId: 'step-1',
        parentSessionId: 'sess-1',
        status: 'failed',
        summary: 'done-ish',
        deliveryTarget: { kind: 'slack', target: '#ops', metadata: { thread: '123' } },
        retryOfTaskId: 't1',
        startedAt: '2026-01-01T00:00:01.000Z',
        completedAt: '2026-01-01T00:00:02.000Z',
        error: { name: 'BoomError', message: 'boom' },
      })
      await store.putTask(task)
      await expect(store.getTask('t2')).resolves.toEqual(task)
    })

    it('updates a task and clears optional fields set to undefined', async () => {
      const store = make()
      await store.putTask(sampleTask('t3', { summary: 'old' }))
      await store.updateTask('t3', {
        status: 'running',
        childRunId: 'run-x',
        summary: undefined,
      })
      const updated = await store.getTask('t3')
      expect(updated?.status).toBe('running')
      expect(updated?.childRunId).toBe('run-x')
      expect(updated?.summary).toBeUndefined()
    })

    it('updateTask on a missing task is a no-op', async () => {
      const store = make()
      await store.updateTask('nope', { status: 'running' })
      await expect(store.getTask('nope')).resolves.toBeNull()
    })

    it('lists tasks filtered by status, parentRunId, and workflowId', async () => {
      const store = make()
      await store.putTask(
        sampleTask('a', { status: 'running', parentRunId: 'p1', workflowId: 'wf-a' }),
      )
      await store.putTask(
        sampleTask('b', { status: 'completed', parentRunId: 'p1', workflowId: 'wf-b' }),
      )
      await store.putTask(
        sampleTask('c', { status: 'running', parentRunId: 'p2', workflowId: 'wf-a' }),
      )

      const running = await store.listTasks({ status: 'running' })
      expect(running.map((t) => t.taskId).sort()).toEqual(['a', 'c'])

      const byParent = await store.listTasks({ parentRunId: 'p1' })
      expect(byParent.map((t) => t.taskId).sort()).toEqual(['a', 'b'])

      const byWorkflow = await store.listTasks({ workflowId: 'wf-a' })
      expect(byWorkflow.map((t) => t.taskId).sort()).toEqual(['a', 'c'])
    })

    it('honors the listTasks limit', async () => {
      const store = make()
      await store.putTask(sampleTask('x', { createdAt: '2026-01-01T00:00:01.000Z' }))
      await store.putTask(sampleTask('y', { createdAt: '2026-01-01T00:00:02.000Z' }))
      await store.putTask(sampleTask('z', { createdAt: '2026-01-01T00:00:03.000Z' }))
      const limited = await store.listTasks({ limit: 2 })
      expect(limited).toHaveLength(2)
      // Newest createdAt first.
      expect(limited[0]?.taskId).toBe('z')
    })
  })

  describe(`${name} — run lineage fields`, () => {
    it('roundtrips parentRunId, parentStepId, and taskId on a run', async () => {
      const store = make()
      await store.putRun(
        sampleRun('child', { parentRunId: 'parent', parentStepId: 'step-7', taskId: 'task-9' }),
      )
      const r = await store.getRun('child')
      expect(r?.parentRunId).toBe('parent')
      expect(r?.parentStepId).toBe('step-7')
      expect(r?.taskId).toBe('task-9')
    })

    it('omits lineage fields for a top-level run', async () => {
      const store = make()
      await store.putRun(sampleRun('top'))
      const r = await store.getRun('top')
      expect(r).not.toHaveProperty('parentRunId')
      expect(r).not.toHaveProperty('taskId')
    })
  })
}

describe('SqliteRunStore — additive migration', () => {
  it('adds tasks table and run lineage columns to a pre-existing v0 schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-tasks-mig-'))
    const path = join(dir, 'runs.sqlite')
    // Simulate an older DB: a runs table without the lineage columns and no
    // tasks table at all.
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE runs (
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
    `)
    legacy.close()

    // Opening through SqliteRunStore must migrate without dropping the old row.
    const store = new SqliteRunStore({ path })
    return (async () => {
      const cols = (
        new Database(path).prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>
      ).map((c) => c.name)
      expect(cols).toContain('parent_run_id')
      expect(cols).toContain('parent_step_id')
      expect(cols).toContain('task_id')

      await store.putTask(sampleTask('mig-task', { childRunId: 'r1', status: 'running' }))
      await expect(store.getTask('mig-task')).resolves.toMatchObject({
        taskId: 'mig-task',
        childRunId: 'r1',
        status: 'running',
      })
      store.close()
    })()
  })
})
