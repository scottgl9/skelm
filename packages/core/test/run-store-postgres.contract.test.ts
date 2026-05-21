import { describe, expect, it } from 'vitest'
import { NotImplementedError, PostgresRunStore } from '../src/index.js'

// M4 seam: pin the constructor + method shape so the eventual Postgres
// driver lands as a pure addition. Once the driver is implemented,
// unskip the inner describe.skip and remove the NotImplementedError
// asserts here.

describe('PostgresRunStore — seam (M4)', () => {
  it('constructs without throwing', () => {
    expect(() => new PostgresRunStore({ url: 'postgres://localhost/test' })).not.toThrow()
  })

  it('every method throws NotImplementedError', async () => {
    const store = new PostgresRunStore({ url: 'postgres://localhost/test' })
    await expect(() =>
      store.putRun({
        runId: 'r1',
        pipelineId: 'p',
        status: 'running',
        startedAt: 0,
        steps: [],
        input: undefined,
      } as never),
    ).rejects.toBeInstanceOf(NotImplementedError)
    await expect(() => store.getRun('r1')).rejects.toBeInstanceOf(NotImplementedError)
    await expect(() => store.appendEvent({ type: 'run.started' } as never)).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })
})

// The full RunStore contract suite for PostgresRunStore is gated on the
// M4 driver implementation. The previous `describe.skip` placeholder
// reported as "1 skipped" in CI, which read as if real contract coverage
// existed for the postgres path. Removed to stop conveying false
// confidence — once the driver lands, import the shared contract
// harness (see packages/core/test/run-store.test.ts for the SqliteRunStore
// invocation) and feed it a containerised pg fixture.
