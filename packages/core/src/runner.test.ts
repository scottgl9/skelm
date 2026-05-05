import { describe, expect, it } from 'vitest'
import { BackendRegistry, BackendUnavailableError, type SkelmBackend } from './backend.js'
import { agent, code, pipeline } from './builders.js'
import { PermissionDeniedError } from './errors.js'
import { EventBus, type RunEvent } from './events.js'
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

describe('runPipeline — backend fallback chain', () => {
  function stubBackend(
    id: string,
    behavior: 'ok' | 'unavailable' | 'permission' = 'ok',
  ): SkelmBackend {
    return {
      id,
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
        if (behavior === 'unavailable')
          throw new BackendUnavailableError(`${id} is unavailable`, id)
        if (behavior === 'permission') throw new PermissionDeniedError(`denied by ${id}`)
        return { text: `from ${id}` }
      },
    }
  }

  it('falls through to the next backend on BackendUnavailableError and emits backend.fallback', async () => {
    const registry = new BackendRegistry()
    registry.register(stubBackend('a', 'unavailable'))
    registry.register(stubBackend('b', 'ok'))
    const events = new EventBus()
    const fallbacks: RunEvent[] = []
    events.subscribe((e) => {
      if (e.type === 'backend.fallback') fallbacks.push(e)
    })
    const wf = pipeline({
      id: 'fb-ok',
      steps: [agent({ id: 'work', backend: ['a', 'b'], prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: registry, events })
    expect(run.status).toBe('completed')
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toMatchObject({ from: 'a', to: 'b' })
  })

  it('does not fall back on logic errors (e.g. PermissionDeniedError)', async () => {
    const registry = new BackendRegistry()
    registry.register(stubBackend('a', 'permission'))
    registry.register(stubBackend('b', 'ok'))
    const events = new EventBus()
    const fallbacks: RunEvent[] = []
    events.subscribe((e) => {
      if (e.type === 'backend.fallback') fallbacks.push(e)
    })
    const wf = pipeline({
      id: 'fb-no',
      steps: [agent({ id: 'work', backend: ['a', 'b'], prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: registry, events })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(fallbacks).toHaveLength(0)
  })

  it('throws BackendChainExhaustedError when every backend in the chain fails transiently', async () => {
    const registry = new BackendRegistry()
    registry.register(stubBackend('a', 'unavailable'))
    registry.register(stubBackend('b', 'unavailable'))
    const wf = pipeline({
      id: 'fb-exhaust',
      steps: [agent({ id: 'work', backend: ['a', 'b'], prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: registry })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendChainExhaustedError')
    expect(run.error?.message).toContain('a')
    expect(run.error?.message).toContain('b')
  })

  it('treats a single-string backend as a chain of length one', async () => {
    const registry = new BackendRegistry()
    registry.register(stubBackend('only', 'ok'))
    const wf = pipeline({
      id: 'fb-single',
      steps: [agent({ id: 'work', backend: 'only', prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: registry })
    expect(run.status).toBe('completed')
  })
})
