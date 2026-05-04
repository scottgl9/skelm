import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { branch, code, forEach, loop, parallel, pipeline, pipelineStep, wait } from './builders.js'
import { RunCancelledError } from './errors.js'
import { Runner, runPipeline } from './runner.js'

describe('parallel()', () => {
  it('runs siblings concurrently and keys output by child id', async () => {
    const wf = pipeline({
      id: 'p',
      steps: [
        parallel({
          id: 'gather',
          steps: [
            code({ id: 'a', run: () => ({ value: 1 }) }),
            code({ id: 'b', run: () => ({ value: 2 }) }),
          ],
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ a: { value: 1 }, b: { value: 2 } })
  })

  it('default onError "fail" aborts the run when a sibling throws', async () => {
    const wf = pipeline({
      id: 'p-fail',
      steps: [
        parallel({
          id: 'gather',
          steps: [
            code({ id: 'ok', run: () => ({ value: 1 }) }),
            code({
              id: 'kaboom',
              run: () => {
                throw new Error('boom')
              },
            }),
          ],
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.message).toBe('boom')
  })

  it('onError "continue" records errors per child without aborting', async () => {
    const wf = pipeline({
      id: 'p-cont',
      steps: [
        parallel({
          id: 'gather',
          onError: 'continue',
          steps: [
            code({ id: 'ok', run: () => ({ value: 1 }) }),
            code({
              id: 'fails',
              run: () => {
                throw new Error('nope')
              },
            }),
          ],
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    const out = run.output as { ok: { value: number }; fails: { error: { message: string } } }
    expect(out.ok).toEqual({ value: 1 })
    expect(out.fails.error.message).toBe('nope')
  })

  it('rejects duplicate child ids at build time', () => {
    expect(() =>
      parallel({
        id: 'dup',
        steps: [code({ id: 'x', run: () => ({}) }), code({ id: 'x', run: () => ({}) })],
      }),
    ).toThrow(/duplicate child step id/)
  })
})

describe('forEach()', () => {
  it('maps a step factory over a collection (concurrency=1)', async () => {
    const wf = pipeline({
      id: 'fe',
      steps: [
        code({ id: 'src', run: () => ({ items: [1, 2, 3] }) }),
        forEach({
          id: 'doubled',
          items: (ctx) => (ctx.steps.src as { items: number[] }).items,
          step: (item) => code({ id: 'dbl', run: () => (item as number) * 2 }),
        }),
      ],
      finalize: (ctx) => ({ values: ctx.steps.doubled }) as { values: number[] },
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ values: [2, 4, 6] })
  })

  it('honors concurrency > 1', async () => {
    const wf = pipeline({
      id: 'fe-c',
      steps: [
        forEach({
          id: 'each',
          items: () => [1, 2, 3, 4],
          concurrency: 4,
          step: (item) => code({ id: 'mul', run: () => (item as number) * (item as number) }),
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(run.output).toEqual([1, 4, 9, 16])
  })

  it('ctx.item is set correctly in concurrent forEach', async () => {
    const wf = pipeline({
      id: 'fe-item-concurrent',
      steps: [
        forEach({
          id: 'each',
          items: () => [{ n: 1 }, { n: 2 }, { n: 3 }],
          concurrency: 3,
          step: () =>
            code({
              id: 'use-item',
              run: (ctx) => ({ value: (ctx.item as { n: number }).n * 10 }),
            }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    // Order is preserved despite concurrent execution
    expect(run.output).toEqual([{ value: 10 }, { value: 20 }, { value: 30 }])
  })
})

describe('branch()', () => {
  it('selects a case based on the discriminator', async () => {
    const wf = pipeline({
      id: 'br',
      steps: [
        code({ id: 'kind', run: (ctx) => ({ kind: (ctx.input as { kind: string }).kind }) }),
        branch({
          id: 'route',
          on: (ctx) => (ctx.steps.kind as { kind: string }).kind,
          cases: {
            a: code({ id: 'do-a', run: () => ({ chose: 'a' }) }),
            b: code({ id: 'do-b', run: () => ({ chose: 'b' }) }),
          },
        }),
      ],
      finalize: (ctx) => ctx.steps.route as { chose: string },
    })

    const run = await runPipeline(wf, { kind: 'b' })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ chose: 'b' })
  })

  it('falls back to default when no case matches', async () => {
    const wf = pipeline({
      id: 'br-default',
      steps: [
        branch({
          id: 'route',
          on: () => 'unknown',
          cases: {
            a: code({ id: 'a', run: () => ({ chose: 'a' }) }),
          },
          default: code({ id: 'fallback', run: () => ({ chose: 'fallback' }) }),
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ chose: 'fallback' })
  })

  it('fails the run when no case matches and no default is provided', async () => {
    const wf = pipeline({
      id: 'br-no-default',
      steps: [
        branch({
          id: 'route',
          on: () => 'nope',
          cases: { a: code({ id: 'a', run: () => ({}) }) },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.message).toMatch(/no case matched/)
  })
})

describe('loop()', () => {
  it('iterates while the predicate holds, bounded by maxIterations', async () => {
    let counter = 0
    const wf = pipeline({
      id: 'lp',
      steps: [
        loop({
          id: 'count',
          maxIterations: 5,
          while: () => counter < 3,
          step: code({
            id: 'tick',
            run: () => {
              counter += 1
              return { n: counter }
            },
          }),
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    const out = run.output as { iterations: { n: number }[]; last: { n: number } }
    expect(out.iterations.map((i) => i.n)).toEqual([1, 2, 3])
    expect(out.last).toEqual({ n: 3 })
  })

  it('respects maxIterations even if predicate stays true', async () => {
    const wf = pipeline({
      id: 'lp-cap',
      steps: [
        loop({
          id: 'forever',
          maxIterations: 2,
          while: () => true,
          step: code({ id: 'tick', run: () => ({ ok: true }) }),
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    const out = run.output as { iterations: unknown[] }
    expect(out.iterations).toHaveLength(2)
  })
})

describe('pipelineStep()', () => {
  it('runs a nested pipeline and records its output on the parent step', async () => {
    const child = pipeline<{ value: number }, { doubled: number }>({
      id: 'child',
      steps: [
        code({
          id: 'double',
          run: (ctx) => ({ doubled: (ctx.input as { value: number }).value * 2 }),
        }),
      ],
    })

    const parent = pipeline<{ value: number }, { nested: { doubled: number } }>({
      id: 'parent',
      steps: [
        pipelineStep({
          id: 'nested',
          pipeline: child,
          input: (ctx) => ({ value: (ctx.input as { value: number }).value }),
        }),
      ],
      finalize: (ctx) => ({ nested: ctx.steps.nested as { doubled: number } }),
    })

    const run = await runPipeline(parent, { value: 21 })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ nested: { doubled: 42 } })
  })

  it('defaults nested input to the parent ctx.input when no mapper is provided', async () => {
    const child = pipeline<{ name: string }, { greeting: string }>({
      id: 'child-default-input',
      steps: [
        code({
          id: 'greet',
          run: (ctx) => ({ greeting: `hello, ${(ctx.input as { name: string }).name}` }),
        }),
      ],
    })

    const parent = pipeline<{ name: string }, { greeting: string }>({
      id: 'parent-default-input',
      steps: [pipelineStep({ id: 'nested', pipeline: child })],
    })

    const run = await runPipeline(parent, { name: 'world' })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ greeting: 'hello, world' })
  })

  it('fails the parent run when the nested pipeline fails', async () => {
    const child = pipeline<unknown, unknown>({
      id: 'child-fail',
      steps: [
        code({
          id: 'boom',
          run: () => {
            throw new Error('nested boom')
          },
        }),
      ],
    })

    const parent = pipeline({
      id: 'parent-fail',
      steps: [pipelineStep({ id: 'nested', pipeline: child })],
    })

    const run = await runPipeline(parent, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('Error')
    expect(run.error?.message).toBe('nested boom')
    expect(run.steps[0]?.status).toBe('failed')
  })

  it('rejects a missing nested pipeline at build time', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse for the test
      pipelineStep({ id: 'bad', pipeline: undefined as any }),
    ).toThrow(/pipeline is required/)
  })
})

describe('wait()', () => {
  it('resumes with external input via Runner.resume()', async () => {
    const wf = pipeline<unknown, { approved: boolean }>({
      id: 'approval',
      steps: [wait({ id: 'gate', output: z.object({ approved: z.boolean() }) })],
    })

    const runner = new Runner()
    const runId = 'wait-resume'
    const waiting = waitForRunWaiting(runner, runId)
    const handle = runner.start(wf, undefined, { runId })
    await waiting
    await runner.resume(handle.runId, { approved: true })

    const run = await handle.wait()
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ approved: true })
  })

  it('fails with WaitTimeoutError when the wait step times out', async () => {
    const wf = pipeline({
      id: 'wait-timeout',
      steps: [wait({ id: 'gate', timeoutMs: 10 })],
    })

    const run = await new Runner().start(wf, undefined).wait()
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('WaitTimeoutError')
  })

  it('publishes run.waiting and run.resumed with step metadata', async () => {
    const runner = new Runner()
    const seen: Array<
      | { type: 'waiting'; runId: string; stepId: string; message?: string }
      | { type: 'resumed'; runId: string; stepId: string; output: unknown }
    > = []
    runner.events.subscribe((event) => {
      if (event.type === 'run.waiting') {
        seen.push({
          type: 'waiting',
          runId: event.runId,
          stepId: event.stepId,
          message: event.message,
        })
      } else if (event.type === 'run.resumed') {
        seen.push({
          type: 'resumed',
          runId: event.runId,
          stepId: event.stepId,
          output: event.output,
        })
      }
    })

    const wf = pipeline({
      id: 'wait-events',
      steps: [wait({ id: 'pause', message: () => 'approval required' })],
    })

    const runId = 'wait-events'
    const waiting = waitForRunWaiting(runner, runId)
    const handle = runner.start(wf, undefined, { runId })
    await waiting
    await runner.resume(handle.runId, { ok: true })
    await handle.wait()

    expect(seen).toEqual([
      {
        type: 'waiting',
        runId: handle.runId,
        stepId: 'pause',
        message: 'approval required',
      },
      {
        type: 'resumed',
        runId: handle.runId,
        stepId: 'pause',
        output: { ok: true },
      },
    ])
  })

  it('marks the run cancelled when the wait handler cancels input', async () => {
    const wf = pipeline({
      id: 'wait-cancel',
      steps: [wait({ id: 'pause' })],
    })

    const run = await runPipeline(wf, undefined, {
      waitForInput: async () => {
        throw new RunCancelledError('cancelled from wait prompt')
      },
    })

    expect(run.status).toBe('cancelled')
    expect(run.error?.name).toBe('RunCancelledError')
    expect(run.steps[0]?.status).toBe('failed')
  })

  it('rejects wait() with an invalid timeout', () => {
    expect(() => wait({ id: 'bad', timeoutMs: 0 })).toThrow(/timeoutMs must be >= 1/)
  })
})

async function waitForRunWaiting(runner: Runner, runId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const unsubscribe = runner.events.forRun(runId, (event) => {
      if (event.type === 'run.waiting') {
        unsubscribe()
        resolve()
      }
    })
  })
}
