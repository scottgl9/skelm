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

// Re-running the full RunStore contract suite against PostgresRunStore
// is what the M4 implementation will need. Kept as a skipped sentinel
// so the M4 PR doesn't need to add the harness — only flip `.skip` off.
describe.skip('PostgresRunStore — full RunStore contract (unskip when M4 lands)', () => {
  it('placeholder', () => {
    /* Replace with imports of the shared contract harness once it exists. */
  })
})
