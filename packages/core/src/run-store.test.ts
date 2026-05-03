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
