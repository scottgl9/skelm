import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from './backend.js'
import { agent, code, pipeline } from './builders.js'
import { StepTimeoutError } from './errors.js'
import { EventBus } from './events.js'
import { runPipeline } from './runner.js'

describe('runPipeline — sequential code steps', () => {
  it('runs a single code step and adopts its output as the run output', async () => {
    const wf = pipeline<{ name: string }, { greeting: string }>({
      id: 'hello',
      steps: [
        code({
          id: 'greet',
          run: (ctx) => ({ greeting: `hello, ${(ctx.input as { name: string }).name}` }),
        }),
      ],
    })

    const run = await runPipeline(wf, { name: 'world' })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ greeting: 'hello, world' })
    expect(run.steps).toHaveLength(1)
    expect(run.steps[0]?.status).toBe('completed')
    expect(run.error).toBeUndefined()
  })

  it('passes prior step outputs through ctx.steps to later steps', async () => {
    const wf = pipeline<unknown, { sum: number }>({
      id: 'add',
      steps: [
        code({ id: 'a', run: () => ({ value: 2 }) }),
        code({ id: 'b', run: () => ({ value: 3 }) }),
        code({
          id: 'sum',
          run: (ctx) => {
            const a = (ctx.steps.a as { value: number }).value
            const b = (ctx.steps.b as { value: number }).value
            return { sum: a + b }
          },
        }),
      ],
      finalize: (ctx) => ctx.steps.sum as { sum: number },
    })

    const run = await runPipeline(wf, undefined)

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ sum: 5 })
    expect(run.steps.map((s) => s.id)).toEqual(['a', 'b', 'sum'])
  })

  it('uses finalize to shape the output if provided', async () => {
    const wf = pipeline<unknown, { tag: string }>({
      id: 'tag',
      steps: [code({ id: 'identify', run: () => ({ kind: 'workflow' }) })],
      finalize: (ctx) => ({ tag: `[${(ctx.steps.identify as { kind: string }).kind}]` }),
    })

    const run = await runPipeline(wf, undefined)
    expect(run.output).toEqual({ tag: '[workflow]' })
  })

  it('marks the run failed and records a step error when a code step throws', async () => {
    const wf = pipeline<unknown, unknown>({
      id: 'boom',
      steps: [
        code({ id: 'ok', run: () => ({}) }),
        code({
          id: 'kaboom',
          run: () => {
            throw new Error('intentional')
          },
        }),
        code({ id: 'never', run: () => ({}) }),
      ],
    })

    const run = await runPipeline(wf, undefined)

    expect(run.status).toBe('failed')
    expect(run.output).toBeUndefined()
    expect(run.error?.message).toBe('intentional')
    expect(run.steps.map((s) => s.id)).toEqual(['ok', 'kaboom'])
    expect(run.steps[1]?.status).toBe('failed')
    expect(run.steps[1]?.error?.message).toBe('intentional')
  })

  it('does not start a step when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const wf = pipeline<unknown, unknown>({
      id: 'pre-aborted',
      steps: [code({ id: 'noop', run: () => ({}) })],
    })

    const run = await runPipeline(wf, undefined, { signal: controller.signal })
    expect(run.status).toBe('cancelled')
    expect(run.steps).toHaveLength(0)
  })

  it('exposes the pipelineId, runId, and timestamps on the Run record', async () => {
    const wf = pipeline<unknown, unknown>({
      id: 'meta',
      steps: [code({ id: 'noop', run: () => ({}) })],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.pipelineId).toBe('meta')
    expect(run.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(run.startedAt).toBeGreaterThan(0)
    expect(run.completedAt).toBeGreaterThanOrEqual(run.startedAt)
  })
})

describe('builders — validation', () => {
  it('rejects a pipeline with no steps', () => {
    expect(() => pipeline<unknown, unknown>({ id: 'empty', steps: [] })).toThrow(
      /at least one step/,
    )
  })

  it('rejects duplicate step ids', () => {
    expect(() =>
      pipeline<unknown, unknown>({
        id: 'dup',
        steps: [code({ id: 'x', run: () => ({}) }), code({ id: 'x', run: () => ({}) })],
      }),
    ).toThrow(/duplicate step id/)
  })

  it('rejects a code step with no run function', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse for the test
      code({ id: 'bad', run: undefined as any }),
    ).toThrow(/run must be a function/)
  })

  it('rejects an invalid retry policy', () => {
    expect(() => code({ id: 'bad-retry', retry: { maxAttempts: 0 }, run: () => ({}) })).toThrow(
      /retry\.maxAttempts must be >= 1/,
    )
  })
})

describe('retry policy', () => {
  it('retries a step until it succeeds and emits step.retry events', async () => {
    let attempts = 0
    const events = new EventBus()
    const retries: Array<{ attempt: number; delayMs?: number }> = []
    events.subscribe((event) => {
      if (event.type === 'step.retry') {
        retries.push({ attempt: event.attempt, delayMs: event.delayMs })
      }
    })

    const wf = pipeline({
      id: 'retry-success',
      steps: [
        code({
          id: 'flaky',
          retry: { maxAttempts: 3, delayMs: 0 },
          run: () => {
            attempts += 1
            if (attempts < 3) {
              throw new Error('transient')
            }
            return { ok: true }
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, { events })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ ok: true })
    expect(attempts).toBe(3)
    expect(retries).toEqual([{ attempt: 1 }, { attempt: 2 }])
  })

  it('fails after exhausting retry attempts', async () => {
    let attempts = 0
    const wf = pipeline({
      id: 'retry-fail',
      steps: [
        code({
          id: 'still-flaky',
          retry: { maxAttempts: 2 },
          run: () => {
            attempts += 1
            throw new Error('still broken')
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.message).toBe('still broken')
    expect(attempts).toBe(2)
  })
})

describe('runPipeline — agent timeoutMs', () => {
  function hangingBackend(opts: {
    onAbort?: () => void
    delayMs?: number
  }): SkelmBackend {
    return {
      id: 'hang-backend',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'wrapped',
      },
      async run(_req, ctx) {
        return await new Promise<{ text: string }>((resolve, reject) => {
          const timer = setTimeout(() => resolve({ text: 'late' }), opts.delayMs ?? 5000)
          ctx.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              opts.onAbort?.()
              reject(new Error('aborted'))
            },
            { once: true },
          )
        })
      },
    }
  }

  it('aborts the backend signal and fails the step with StepTimeoutError', async () => {
    const registry = new BackendRegistry()
    let aborted = false
    registry.register(hangingBackend({ onAbort: () => (aborted = true) }))
    const wf = pipeline({
      id: 'timeout-runner',
      steps: [agent({ id: 'work', backend: 'hang-backend', prompt: 'hi', timeoutMs: 25 })],
    })
    const run = await runPipeline(wf, undefined, { backends: registry })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('StepTimeoutError')
    expect(aborted).toBe(true)
  })

  it('retries after a timeout when retry policy is set', async () => {
    const registry = new BackendRegistry()
    let calls = 0
    registry.register({
      id: 'flaky-backend',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'wrapped',
      },
      async run(_req, ctx) {
        calls += 1
        if (calls < 2) {
          return await new Promise<{ text: string }>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        }
        return { text: 'eventually' }
      },
    } as SkelmBackend)
    const wf = pipeline({
      id: 'timeout-retry',
      steps: [
        agent({
          id: 'work',
          backend: 'flaky-backend',
          prompt: 'hi',
          timeoutMs: 25,
          retry: { maxAttempts: 2, delayMs: 0 },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends: registry })
    expect(run.status).toBe('completed')
    expect(calls).toBe(2)
  })

  it('does not impose a timeout when timeoutMs is absent', async () => {
    const registry = new BackendRegistry()
    registry.register({
      id: 'fast',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'wrapped',
      },
      async run() {
        return { text: 'instant' }
      },
    } as SkelmBackend)
    const wf = pipeline({
      id: 'no-timeout',
      steps: [agent({ id: 'work', backend: 'fast', prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: registry })
    expect(run.status).toBe('completed')
  })

  it('rejects negative or zero timeoutMs at builder time', () => {
    expect(() => agent({ id: 'bad', backend: 'x', prompt: 'hi', timeoutMs: 0 })).toThrow(
      /timeoutMs/,
    )
    expect(() => agent({ id: 'bad', backend: 'x', prompt: 'hi', timeoutMs: -1 })).toThrow(
      /timeoutMs/,
    )
  })

  it('StepTimeoutError carries stepId and timeoutMs', () => {
    const err = new StepTimeoutError('work', 1000)
    expect(err.stepId).toBe('work')
    expect(err.timeoutMs).toBe(1000)
  })
})
