import { describe, expect, it } from 'vitest'
import { MemoryRunStore, code, pipeline, runPipeline, wait } from '../src/index.js'

describe('runner — wait/resume run row mirror', () => {
  it('mirrors wait and resume status transitions into the persisted run row', async () => {
    const store = new MemoryRunStore()
    const observed: string[] = []
    const wf = pipeline({
      id: 'wait-row-state',
      steps: [
        code({ id: 'prep', run: () => ({ ready: true }) }),
        wait({ id: 'gate', message: 'pause for input' }),
        code({ id: 'finish', run: (ctx) => ({ resumed: ctx.steps.gate }) }),
      ],
      finalize: (ctx) => ctx.steps.finish,
    })

    const run = await runPipeline(wf, undefined, {
      store,
      waitForInput: async (request) => {
        const parked = await waitForRun(store, request.runId, (candidate) =>
          candidate?.status === 'waiting' ? candidate : null,
        )
        expect(parked.waiting).toMatchObject({
          stepId: 'gate',
          message: 'pause for input',
        })
        observed.push('waiting')
        return { ok: true }
      },
      beforeStep: async ({ runId, stepId }) => {
        if (stepId !== 'finish') return
        const resumed = await waitForRun(store, runId, (candidate) =>
          candidate?.status === 'running' && candidate.waiting === undefined ? candidate : null,
        )
        expect(resumed.steps.map((step) => step.id)).toEqual(['prep', 'gate'])
        observed.push('running')
      },
    })

    expect(run.status).toBe('completed')
    expect(observed).toEqual(['waiting', 'running'])
    const persisted = await store.getRun(run.runId)
    expect(persisted?.status).toBe('completed')
    expect(persisted?.waiting).toBeUndefined()
    expect(persisted?.steps.map((step) => step.id)).toEqual(['prep', 'gate', 'finish'])
  })
})

async function waitForRun<T>(
  store: MemoryRunStore,
  runId: string,
  match: (candidate: Awaited<ReturnType<MemoryRunStore['getRun']>>) => T | null,
): Promise<T> {
  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    const candidate = await store.getRun(runId)
    const matched = match(candidate)
    if (matched !== null) return matched
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for run ${runId}`)
}
