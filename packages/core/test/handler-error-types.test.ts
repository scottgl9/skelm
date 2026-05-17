import { describe, expect, it } from 'vitest'
import { BranchExhaustionError, StepKindError, WaitConfigError } from '../src/errors.js'
import { branch, code, pipeline, runPipeline, wait } from '../src/index.js'

// Bare `Error` throws in handlers.ts defeated structured audit (StepError
// serialization keys off `error.name`). These tests pin the typed names
// so a regression surfaces immediately.

describe('handler error types', () => {
  it('BranchExhaustionError fires when no case matches and no default exists', async () => {
    const wf = pipeline({
      id: 'br',
      steps: [
        branch({
          id: 'b',
          on: () => 'missing',
          cases: {
            other: code({
              id: 'x',
              async run() {
                return 1
              },
            }),
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BranchExhaustionError')
    expect(new BranchExhaustionError('b', 'missing').stepId).toBe('b')
  })

  it('WaitConfigError fires when wait() runs without a waitForInput handler', async () => {
    const wf = pipeline({ id: 'wa', steps: [wait({ id: 'w' })] })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('WaitConfigError')
    expect(new WaitConfigError('w').stepId).toBe('w')
  })

  it('StepKindError exposes the offending kind', () => {
    const e = new StepKindError('mystery')
    expect(e.name).toBe('StepKindError')
    expect(e.kind).toBe('mystery')
    expect(e.message).toMatch(/mystery/)
  })
})
