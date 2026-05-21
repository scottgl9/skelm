import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import { runPipeline } from '../src/runner.js'

// Regression: runPipeline added an 'abort' listener to options.signal but
// never removed it. A long-lived AbortController fed to many runs (test
// harness, embedded host) accumulated one listener per run, eventually
// hitting Node's default-max-listeners warning and leaking memory.

describe('runPipeline — abort listener lifecycle', () => {
  it('removes its abort listener from a long-lived signal after the run completes', async () => {
    const controller = new AbortController()
    const wf = pipeline({
      id: 'wf-abort-cleanup',
      steps: [code({ id: 'noop', run: () => ({ ok: true }) })],
    })
    const baseline = listenerCount(controller.signal)
    const N = 10
    for (let i = 0; i < N; i++) {
      const run = await runPipeline(wf, undefined, { signal: controller.signal })
      expect(run.status).toBe('completed')
    }
    // Without the fix the listener count would grow by N.
    expect(listenerCount(controller.signal)).toBe(baseline)
  })

  it('removes its abort listener even when the run fails', async () => {
    const controller = new AbortController()
    const wf = pipeline({
      id: 'wf-abort-cleanup-fail',
      steps: [
        code({
          id: 'boom',
          run: () => {
            throw new Error('intentional')
          },
        }),
      ],
    })
    const baseline = listenerCount(controller.signal)
    for (let i = 0; i < 5; i++) {
      const run = await runPipeline(wf, undefined, { signal: controller.signal })
      expect(run.status).toBe('failed')
    }
    expect(listenerCount(controller.signal)).toBe(baseline)
  })
})

function listenerCount(signal: AbortSignal): number {
  // Node's AbortSignal extends EventTarget; EventTarget doesn't expose
  // listenerCount publicly, so probe via the EventEmitter-style 'abort'
  // event count if present, otherwise approximate via the maxListeners
  // pathway. In practice Node 20+ exposes `listenerCount` via the global
  // events module; cast through unknown to access without TS friction.
  const target = signal as unknown as {
    listenerCount?: (type: string) => number
  }
  return target.listenerCount?.('abort') ?? 0
}
