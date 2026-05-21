import { describe, expect, it } from 'vitest'
import { StepTimeoutError, code, pipeline, runPipeline } from '../src/index.js'

// Code steps now honor `timeoutMs` and abort ctx.signal when exceeded.
// Authors who ignore ctx.signal still lose the race; the wrapping promise
// rejects with StepTimeoutError so a runaway code step cannot wedge the
// gateway.

describe('runCodeStep — timeoutMs enforcement', () => {
  it('rejects with StepTimeoutError when the budget elapses', async () => {
    const wf = pipeline({
      id: 'code-timeout',
      steps: [
        code({
          id: 'sleeper',
          timeoutMs: 25,
          async run() {
            // Deliberately ignore ctx.signal — the wrapper must still abort.
            await new Promise((r) => setTimeout(r, 500))
            return { ok: true }
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('StepTimeoutError')
  })

  it('completes normally when the step finishes within the budget', async () => {
    const wf = pipeline({
      id: 'code-fast',
      steps: [
        code({
          id: 'fast',
          timeoutMs: 200,
          async run() {
            return { ok: true }
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
  })

  it('forwards aborted ctx.signal so signal-aware code can exit early', async () => {
    let observed = false
    const wf = pipeline({
      id: 'code-signal-aware',
      steps: [
        code({
          id: 'aware',
          timeoutMs: 25,
          async run(ctx) {
            await new Promise<void>((resolve) => {
              ctx.signal.addEventListener('abort', () => {
                observed = true
                resolve()
              })
            })
            throw new StepTimeoutError('aware', 25)
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(observed).toBe(true)
  })
})
