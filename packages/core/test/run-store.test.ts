import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import { StateConfigError } from '../src/errors.js'
import { EventBus } from '../src/events.js'
import { MemoryRunStore, SqliteRunStore } from '../src/run-store.js'
import { runPipeline } from '../src/runner.js'
import type { Run } from '../src/types.js'

describe('MemoryRunStore', () => {
  it('stores runs and events', async () => {
    const store = new MemoryRunStore()
    const run = sampleRun('run-1')
    await store.putRun(run)
    await store.appendEvent({ type: 'run.started', runId: 'run-1', at: 1 })

    await expect(store.getRun('run-1')).resolves.toEqual(run)
    await expect(collect(store.listRuns())).resolves.toEqual([
      {
        runId: 'run-1',
        pipelineId: 'p',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
      },
    ])
    await expect(collect(store.listEvents('run-1'))).resolves.toEqual([
      { type: 'run.started', runId: 'run-1', at: 1 },
    ])
  })

  it('keeps listRuns length compatibility while remaining async iterable', async () => {
    const store = new MemoryRunStore()
    await store.putRun(sampleRun('run-1'))

    const listed = await store.listRuns({})

    expect((listed as { length?: number }).length).toBe(1)
    await expect(collect(listed)).resolves.toEqual([
      {
        runId: 'run-1',
        pipelineId: 'p',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
      },
    ])
  })

  it('stores workflow state and journals', async () => {
    const store = new MemoryRunStore()

    await store.setState('pipeline:p', 'seen:1', true)
    await expect(store.getState('pipeline:p', 'seen:1')).resolves.toBe(true)
    await expect(collect(store.listState('pipeline:p'))).resolves.toEqual([
      { key: 'seen:1', value: true },
    ])
    await expect(store.casState('pipeline:p', 'seen:1', true, false)).resolves.toBe(true)
    await expect(store.casState('pipeline:p', 'seen:1', true, true)).resolves.toBe(false)
    await store.appendState('pipeline:p', 'decisions', { ok: true })
    await expect(collect(store.readState('pipeline:p', 'decisions'))).resolves.toEqual([
      { ok: true },
    ])

    await store.setState('pipeline:p', 'expires', 'soon', { ttlMs: 0 })
    await expect(store.getState('pipeline:p', 'expires')).resolves.toBeUndefined()
  })
})

describe('SqliteRunStore', () => {
  it('persists runs and events to sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-runs-'))
    const store = new SqliteRunStore({ path: join(dir, 'runs.db') })
    try {
      const run = sampleRun('run-1')
      await store.putRun(run)
      await store.appendEvent({ type: 'run.started', runId: 'run-1', at: 1 })

      await expect(store.getRun('run-1')).resolves.toEqual(run)
      await expect(collect(store.listRuns())).resolves.toEqual([
        {
          runId: 'run-1',
          pipelineId: 'p',
          status: 'completed',
          startedAt: 1,
          completedAt: 2,
        },
      ])
      await expect(collect(store.listEvents('run-1'))).resolves.toEqual([
        { type: 'run.started', runId: 'run-1', at: 1 },
      ])
    } finally {
      store.close()
    }
  })

  it('persists workflow state and journals to sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-state-'))
    const store = new SqliteRunStore({ path: join(dir, 'runs.db') })
    try {
      await store.setState('pipeline:p', 'seen:1', true)
      await expect(store.getState('pipeline:p', 'seen:1')).resolves.toBe(true)
      await expect(collect(store.listState('pipeline:p'))).resolves.toEqual([
        { key: 'seen:1', value: true },
      ])
      await expect(store.casState('pipeline:p', 'seen:1', true, false)).resolves.toBe(true)
      await expect(store.casState('pipeline:p', 'seen:1', true, true)).resolves.toBe(false)
      await store.appendState('pipeline:p', 'decisions', { ok: true })
      await expect(collect(store.readState('pipeline:p', 'decisions'))).resolves.toEqual([
        { ok: true },
      ])

      await store.setState('pipeline:p', 'expires', 'soon', { ttlMs: 0 })
      await expect(store.getState('pipeline:p', 'expires')).resolves.toBeUndefined()
    } finally {
      store.close()
    }
  })
})

describe('runPipeline with RunStore', () => {
  it('writes emitted events and the final run record', async () => {
    const store = new MemoryRunStore()
    const bus = new EventBus()
    const wf = pipeline({
      id: 'stored',
      steps: [
        code({
          id: 'hello',
          run: () => ({ ok: true }),
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, { events: bus, store })
    expect(run.status).toBe('completed')
    await expect(store.getRun(run.runId)).resolves.toEqual(run)
    await expect(collect(store.listEvents(run.runId))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'run.created', runId: run.runId }),
        expect.objectContaining({ type: 'step.complete', runId: run.runId, stepId: 'hello' }),
        expect.objectContaining({ type: 'run.completed', runId: run.runId }),
      ]),
    )
  })

  it('exposes ctx.state with pipeline, step, and shared scopes', async () => {
    const store = new MemoryRunStore()
    const pipelineScoped = pipeline({
      id: 'scope-a',
      steps: [
        code({
          id: 'write',
          run: async (ctx) => {
            await ctx.state.set('watermark', 42)
            return null
          },
        }),
        code({
          id: 'read',
          run: (ctx) => ctx.state.get<number>('watermark'),
        }),
      ],
    })

    const stepScoped = pipeline({
      id: 'scope-step',
      steps: [
        code({
          id: 'write-step',
          state: { scope: 'step' },
          run: async (ctx) => {
            await ctx.state.set('secret', 'hidden')
            return null
          },
        }),
        code({
          id: 'read-step',
          run: (ctx) => ctx.state.get<string>('secret'),
        }),
      ],
    })

    const sharedA = pipeline({
      id: 'shared-a',
      steps: [
        code({
          id: 'write-shared',
          state: { scope: 'pipeline+name', name: 'shared-box' },
          run: async (ctx) => {
            await ctx.state.set('flag', 'ready')
            await ctx.state.append('journal', { from: 'shared-a' })
            return null
          },
        }),
      ],
    })

    const sharedB = pipeline({
      id: 'shared-b',
      steps: [
        code({
          id: 'read-shared',
          state: { scope: 'pipeline+name', name: 'shared-box' },
          run: async (ctx) => ({
            flag: await ctx.state.get<string>('flag'),
            journal: await collect(ctx.state.read('journal')),
          }),
        }),
      ],
    })

    const pipelineRun = await runPipeline(pipelineScoped, undefined, { store })
    const stepRun = await runPipeline(stepScoped, undefined, { store })
    await runPipeline(sharedA, undefined, { store })
    const sharedRun = await runPipeline(sharedB, undefined, { store })

    expect(pipelineRun.output).toBe(42)
    expect(stepRun.output).toBeUndefined()
    expect(sharedRun.output).toEqual({
      flag: 'ready',
      journal: [{ from: 'shared-a' }],
    })
  })

  it('can derive scoped state handles from the current context', async () => {
    const store = new MemoryRunStore()
    const wf = pipeline({
      id: 'scoped-handle',
      steps: [
        code({
          id: 'write',
          run: async (ctx) => {
            await ctx.state.set('pipeline-key', 'pipeline')
            const shared = ctx.state.scope({ scope: 'pipeline+name', name: 'package-cache' })
            await shared.set('cursor', { page: 2 })
            await shared.append('journal', { event: 'advanced' })
            return null
          },
        }),
        code({
          id: 'read-step',
          state: { scope: 'step' },
          run: async (ctx) => {
            await ctx.state.set('step-key', 'step-only')
            const pipelineState = ctx.state.scope({ scope: 'pipeline' })
            const shared = ctx.state.scope({ scope: 'pipeline+name', name: 'package-cache' })
            return {
              pipeline: await pipelineState.get<string>('pipeline-key'),
              stepLocal: await ctx.state.get<string>('step-key'),
              sharedCursor: await shared.get<{ page: number }>('cursor'),
              sharedJournal: await collect(shared.read('journal')),
            }
          },
        }),
        code({
          id: 'read-pipeline',
          run: async (ctx) => ({
            stepKeyVisible: await ctx.state.get<string>('step-key'),
            sharedCursor: await ctx.state
              .scope({ scope: 'pipeline+name', name: 'package-cache' })
              .get<{ page: number }>('cursor'),
          }),
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, { store })

    expect(run.steps?.[1]?.output).toEqual({
      pipeline: 'pipeline',
      stepLocal: 'step-only',
      sharedCursor: { page: 2 },
      sharedJournal: [{ event: 'advanced' }],
    })
    expect(run.output).toEqual({
      stepKeyVisible: undefined,
      sharedCursor: { page: 2 },
    })
  })

  it('rejects unnamed shared state scopes at handle derivation time', async () => {
    const wf = pipeline({
      id: 'bad-scope',
      steps: [
        code({
          id: 'derive',
          run: (ctx) => ctx.state.scope({ scope: 'pipeline+name' }).get('x'),
        }),
      ],
    })

    const run = await runPipeline(wf)

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('StateConfigError')
    expect(run.error?.message).toContain('state scope "pipeline+name" requires a non-empty name')
  })

  it('rejects step-scoped state handles without a current step id', async () => {
    const wf = pipeline({
      id: 'bad-step-scope',
      steps: [
        code({
          id: 'seed',
          run: () => 'ok',
        }),
      ],
      finalize: (ctx) => ctx.state.scope({ scope: 'step' }).get('x'),
    })

    const run = await runPipeline(wf)

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('StateConfigError')
    expect(run.error?.message).toContain('state scope "step" requires a current step id')
  })

  it('exports invalid state scopes as typed errors', () => {
    expect(new StateConfigError('bad').name).toBe('StateConfigError')
  })
})

function sampleRun(runId: string): Run {
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
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) {
    out.push(item)
  }
  return out
}

describe('workflowPath persistence', () => {
  it('MemoryRunStore: roundtrips workflowPath', async () => {
    const store = new MemoryRunStore()
    await store.putRun({ ...sampleRun('r1'), workflowPath: '/repo/workflows/foo.workflow.ts' })
    const r = await store.getRun('r1')
    expect(r?.workflowPath).toBe('/repo/workflows/foo.workflow.ts')
  })

  it('MemoryRunStore: workflowPath absent when not set', async () => {
    const store = new MemoryRunStore()
    await store.putRun(sampleRun('r2'))
    const r = await store.getRun('r2')
    expect(r?.workflowPath).toBeUndefined()
  })

  it('SqliteRunStore: roundtrips workflowPath', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-wp-'))
    const store = new SqliteRunStore({ path: join(dir, 'runs.db') })
    try {
      await store.putRun({ ...sampleRun('r3'), workflowPath: '/repo/workflows/bar.workflow.ts' })
      const r = await store.getRun('r3')
      expect(r?.workflowPath).toBe('/repo/workflows/bar.workflow.ts')
    } finally {
      store.close()
    }
  })

  it('SqliteRunStore: workflowPath in listRuns summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-wp2-'))
    const store = new SqliteRunStore({ path: join(dir, 'runs.db') })
    try {
      await store.putRun({ ...sampleRun('r4'), workflowPath: '/repo/workflows/baz.ts' })
      const summaries: import('./run-store.js').RunSummary[] = []
      for await (const s of store.listRuns()) summaries.push(s)
      expect(summaries.find((s) => s.runId === 'r4')?.workflowPath).toBe('/repo/workflows/baz.ts')
    } finally {
      store.close()
    }
  })

  it('MemoryRunStore: filters listRuns by startedAfter/startedBefore', async () => {
    const store = new MemoryRunStore()
    await store.putRun({ ...sampleRun('a'), startedAt: 100 })
    await store.putRun({ ...sampleRun('b'), startedAt: 200 })
    await store.putRun({ ...sampleRun('c'), startedAt: 300 })

    const after = await collect(store.listRuns({ startedAfter: 200 }))
    expect(after.map((r) => r.runId).sort()).toEqual(['b', 'c'])

    const before = await collect(store.listRuns({ startedBefore: 200 }))
    expect(before.map((r) => r.runId).sort()).toEqual(['a', 'b'])

    const window = await collect(store.listRuns({ startedAfter: 150, startedBefore: 250 }))
    expect(window.map((r) => r.runId)).toEqual(['b'])
  })

  it('SqliteRunStore: filters listRuns by startedAfter/startedBefore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-filter-'))
    const store = new SqliteRunStore({ path: join(dir, 'runs.db') })
    try {
      await store.putRun({ ...sampleRun('a'), startedAt: 100 })
      await store.putRun({ ...sampleRun('b'), startedAt: 200 })
      await store.putRun({ ...sampleRun('c'), startedAt: 300 })

      const window = await collect(
        store.listRuns({ startedAfter: 150, startedBefore: 250, pipelineId: 'p' }),
      )
      expect(window.map((r) => r.runId)).toEqual(['b'])
    } finally {
      store.close()
    }
  })

  it('SqliteRunStore: concurrent updateRun calls apply exactly one patch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-concurrent-'))
    const store = new SqliteRunStore({ path: join(dir, 'runs.db') })
    try {
      await store.putRun(sampleRun('r-concurrent'))
      await Promise.all([
        store.updateRun('r-concurrent', { status: 'failed' }),
        store.updateRun('r-concurrent', { status: 'cancelled' }),
      ])
      const updated = await store.getRun('r-concurrent')
      expect(updated).not.toBeNull()
      expect(['failed', 'cancelled']).toContain(updated?.status)
      // Ensure the row is fully intact — no partial write
      expect(updated?.runId).toBe('r-concurrent')
      expect(updated?.pipelineId).toBe('p')
    } finally {
      store.close()
    }
  })

  it('SqliteRunStore: migrates existing DB without workflow_path column', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-migrate-'))
    // Create a DB without the workflow_path column (old schema)
    const Database = (await import('better-sqlite3')).default
    const db = new Database(join(dir, 'runs.db'))
    db.exec(`CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      output_json TEXT,
      error_json TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    )`)
    db.close()
    // Open with SqliteRunStore — migration should add the column
    const store = new SqliteRunStore({ path: join(dir, 'runs.db') })
    try {
      await store.putRun(sampleRun('r5'))
      const r = await store.getRun('r5')
      expect(r?.runId).toBe('r5')
      expect(r?.workflowPath).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
