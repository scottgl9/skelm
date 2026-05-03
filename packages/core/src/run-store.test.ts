import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { code, pipeline } from './builders.js'
import { EventBus } from './events.js'
import { MemoryRunStore, SqliteRunStore } from './run-store.js'
import { runPipeline } from './runner.js'
import type { Run } from './types.js'

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
