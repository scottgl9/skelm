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

// When the backing store falls behind, the runner emits a single
// run.warning(code='store.saturated') and a matching 'store.recovered'
// once the queue drains. No events are dropped.

class SlowRunStore implements Partial<RunStore> {
  inner = new MemoryRunStore()
  appendCalls = 0
  resolves: Array<() => void> = []

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
  // State + journal passthrough — runner only touches appendEvent/putRun.
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
    return new Promise<void>((resolve) => {
      this.resolves.push(() => {
        void this.inner.appendEvent(event).then(resolve)
      })
    })
  }

  releaseAll(): void {
    const drained = this.resolves.splice(0)
    for (const r of drained) r()
  }
}

describe('runner — store backpressure', () => {
  it('emits store.saturated when appendEvent queue depth crosses the cap', async () => {
    const store = new SlowRunStore() as unknown as RunStore
    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((e) => seen.push(e))

    // Drive many events from a single step by publishing manually after
    // the runner has subscribed. Each step.start/complete passes through
    // the subscribe → appendEvent path; we add bulk via a code step that
    // emits via the EventBus directly.
    const wf = pipeline({
      id: 'backpressure',
      steps: [
        code({
          id: 'burst',
          async run(ctx) {
            for (let i = 0; i < 300; i++) {
              events.publish({
                type: 'run.warning',
                runId: ctx.run.runId,
                code: 'test.burst',
                message: `b${i}`,
                at: Date.now(),
              })
            }
            return { ok: true }
          },
        }),
      ],
    })

    const runPromise = runPipeline(wf, undefined, { store, events })
    // Let the burst publish, then drain.
    await new Promise((r) => setTimeout(r, 50))
    ;(store as unknown as SlowRunStore).releaseAll()
    // Drain any remaining resolvers that landed after the first sweep.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 10))
      ;(store as unknown as SlowRunStore).releaseAll()
    }
    const run = await runPromise

    expect(run.status).toBe('completed')
    const codes = seen
      .filter((e) => e.type === 'run.warning')
      .map((e) => (e as { code: string }).code)
    expect(codes).toContain('store.saturated')
    expect(codes).toContain('store.recovered')
    expect(codes.filter((c) => c === 'store.saturated').length).toBe(1)
  })

  it('does not emit store.saturated under normal load', async () => {
    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((e) => seen.push(e))
    const store = new MemoryRunStore()
    const wf = pipeline({
      id: 'cool',
      steps: [
        code({
          id: 's',
          async run() {
            return { ok: true }
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { store, events })
    expect(run.status).toBe('completed')
    const sat = seen.filter(
      (e) => e.type === 'run.warning' && (e as { code: string }).code === 'store.saturated',
    )
    expect(sat).toHaveLength(0)
  })
})
