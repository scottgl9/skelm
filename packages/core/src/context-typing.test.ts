import { describe, expect, expectTypeOf, it } from 'vitest'
import { code, pipeline } from './builders.js'
import { runPipeline } from './runner.js'
import type { Context } from './types.js'

describe('Context.get<T>', () => {
  it('reads prior step outputs with the asserted shape', async () => {
    const wf = pipeline<unknown, { sum: number }>({
      id: 'ctx-get',
      steps: [
        code({ id: 'a', run: () => ({ value: 2 }) }),
        code({ id: 'b', run: () => ({ value: 3 }) }),
        code({
          id: 'sum',
          run: (ctx) => {
            const a = ctx.get<{ value: number }>('a')
            const b = ctx.get<{ value: number }>('b')
            return { sum: (a?.value ?? 0) + (b?.value ?? 0) }
          },
        }),
      ],
      finalize: (ctx) => ctx.get<{ sum: number }>('sum') ?? { sum: 0 },
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ sum: 5 })
  })

  it('returns undefined for unknown step ids', async () => {
    const wf = pipeline<unknown, unknown>({
      id: 'ctx-get-missing',
      steps: [
        code({
          id: 'probe',
          run: (ctx) => ({ found: ctx.get<unknown>('does-not-exist') === undefined }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ found: true })
  })

  it('preserves the unknown fallback on ctx.steps so existing call sites still compile', () => {
    type Ctx = Context<unknown>
    expectTypeOf<Ctx['steps']>().toEqualTypeOf<Readonly<Record<string, unknown>>>()
    expectTypeOf<Ctx['get']>().toBeFunction()
    expectTypeOf<ReturnType<Ctx['get']>>().toEqualTypeOf<unknown>()
    expectTypeOf<Ctx['get']>().toBeCallableWith('any-step-id')
    expectTypeOf<Ctx>().toHaveProperty('get')
  })
})
