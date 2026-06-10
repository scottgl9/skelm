import { describe, expect, it } from 'vitest'
import {
  EventBus,
  MemoryRunStore,
  type RunEvent,
  type RunStore,
  code,
  pipeline,
  runPipeline,
} from '../src/index.js'

// A transient appendEvent failure must not poison the run. Event writes are
// best-effort: an uncaught rejection here would both surface as an
// unhandledRejection (fatal to the gateway loop) and reject the finalize-time
// Promise.all, skipping the terminal putRun so a *completed* run is persisted
// as 'running' and later recovered as failed. The runner .catch-wraps the
// append so a failed event write is logged but never aborts finalization.

class FailingAppendStore implements Partial<RunStore> {
  inner = new MemoryRunStore()
  failuresRemaining: number
  appendCalls = 0

  constructor(failuresRemaining = Number.POSITIVE_INFINITY) {
    this.failuresRemaining = failuresRemaining
  }

  putRun(run: Parameters<RunStore['putRun']>[0]): Promise<void> {
    return this.inner.putRun(run)
  }
  updateRun(...args: Parameters<RunStore['updateRun']>): Promise<void> {
    return this.inner.updateRun(...args)
  }
  getRun(...args: Parameters<RunStore['getRun']>): ReturnType<RunStore['getRun']> {
    return this.inner.getRun(...args)
  }
  listRuns(...args: Parameters<RunStore['listRuns']>): ReturnType<RunStore['listRuns']> {
    return this.inner.listRuns(...args)
  }
  listEvents(...args: Parameters<RunStore['listEvents']>): ReturnType<RunStore['listEvents']> {
    return this.inner.listEvents(...args)
  }
  getState(..._args: unknown[]): Promise<undefined> {
    return Promise.resolve(undefined)
  }
  setState(): Promise<void> {
    return Promise.resolve()
  }
  deleteState(): Promise<void> {
    return Promise.resolve()
  }
  async *listState(): AsyncIterable<never> {}
  casState(): Promise<boolean> {
    return Promise.resolve(true)
  }
  appendState(): Promise<void> {
    return Promise.resolve()
  }
  async *readState(): AsyncIterable<never> {}

  appendEvent(event: RunEvent): Promise<void> {
    this.appendCalls += 1
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      return Promise.reject(new Error('simulated transient appendEvent failure'))
    }
    return this.inner.appendEvent(event)
  }
}

describe('runner — appendEvent failure isolation', () => {
  const wf = pipeline({
    id: 'append-failure',
    steps: [
      code({
        id: 's',
        async run() {
          return { ok: true }
        },
      }),
    ],
  })

  it('finalizes a completed run even when every appendEvent rejects', async () => {
    const store = new FailingAppendStore() as unknown as RunStore
    const events = new EventBus()

    // Before the fix this throws (finalize Promise.all rejects on the first
    // failed append) instead of returning a completed run.
    const run = await runPipeline(wf, undefined, { store, events })

    expect(run.status).toBe('completed')
    expect((store as unknown as FailingAppendStore).appendCalls).toBeGreaterThan(0)
    // The terminal record was written, so the durable run reads back completed
    // (not stranded at 'running' for recoverInterruptedRuns to fail).
    const persisted = await store.getRun(run.runId)
    expect(persisted?.status).toBe('completed')
  })

  it('survives a single transient appendEvent failure and still persists events', async () => {
    const store = new FailingAppendStore(1) as unknown as RunStore
    const events = new EventBus()

    const run = await runPipeline(wf, undefined, { store, events })

    expect(run.status).toBe('completed')
    const persisted = await store.getRun(run.runId)
    expect(persisted?.status).toBe('completed')
  })
})
