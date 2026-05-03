import { describe, expect, it } from 'vitest'
import { branch, code, forEach, loop, parallel, pipeline } from './builders.js'
import { runPipeline } from './runner.js'

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
