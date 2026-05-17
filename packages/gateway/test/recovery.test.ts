import { MemoryRunStore, type Run } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { recoverInterruptedRuns } from '../src/lifecycle/recovery.js'

const fixedRun = (overrides: Partial<Run>): Run =>
  Object.freeze({
    runId: 'r-1',
    pipelineId: 'p',
    status: 'running',
    input: undefined,
    steps: Object.freeze([]),
    output: undefined,
    error: undefined,
    startedAt: Date.now(),
    completedAt: undefined,
    ...overrides,
  } as Run)

describe('recoverInterruptedRuns', () => {
  it('marks `running` runs failed with RunCrashedError', async () => {
    const store = new MemoryRunStore()
    await store.putRun(fixedRun({ runId: 'crashed' }))

    const result = await recoverInterruptedRuns(store)

    expect(result.recovered).toEqual(['crashed'])
    const after = await store.getRun('crashed')
    expect(after?.status).toBe('failed')
    expect(after?.error?.name).toBe('RunCrashedError')
    expect(after?.completedAt).toBeTypeOf('number')
  })

  it('leaves terminal runs alone', async () => {
    const store = new MemoryRunStore()
    await store.putRun(fixedRun({ runId: 'done', status: 'completed', completedAt: 1 }))
    await store.putRun(fixedRun({ runId: 'fail', status: 'failed', completedAt: 1 }))

    const result = await recoverInterruptedRuns(store)

    expect(result.recovered).toEqual([])
    expect((await store.getRun('done'))?.status).toBe('completed')
    expect((await store.getRun('fail'))?.status).toBe('failed')
  })

  it('is idempotent — a second pass recovers nothing', async () => {
    const store = new MemoryRunStore()
    await store.putRun(fixedRun({ runId: 'crashed' }))
    await recoverInterruptedRuns(store)
    const second = await recoverInterruptedRuns(store)
    expect(second.recovered).toEqual([])
  })
})
