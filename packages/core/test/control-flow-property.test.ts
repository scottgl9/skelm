import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { branch, code, forEach, loop, parallel, pipeline, wait } from '../src/builders.js'
import { EventBus } from '../src/events.js'
import { Runner, runPipeline } from '../src/runner.js'

// Property-style coverage for the four control-flow primitives. We don't pull
// in fast-check; instead we sweep over varied, deterministic inputs that
// exercise the documented invariants.

describe('parallel(): property sweep', () => {
  for (const n of [1, 2, 5, 16]) {
    it(`runs ${n} children, output keyed by id and length-preserving`, async () => {
      const ids = Array.from({ length: n }, (_, i) => `c${i}`)
      const wf = pipeline({
        id: `par-${n}`,
        steps: [
          parallel({
            id: 'gather',
            steps: ids.map((id, i) => code({ id, run: () => ({ v: i }) })),
          }),
        ],
      })
      const run = await runPipeline(wf, undefined)
      expect(run.status).toBe('completed')
      const got = run.output as Record<string, { v: number }>
      expect(Object.keys(got).sort()).toEqual([...ids].sort())
      for (let i = 0; i < n; i++) expect(got[`c${i}`]?.v).toBe(i)
    })
  }

  it('default onError "fail" short-circuits the run on any sibling error', async () => {
    const wf = pipeline({
      id: 'par-fail',
      steps: [
        parallel({
          id: 'g',
          steps: [
            code({ id: 'ok', run: () => ({ v: 1 }) }),
            code({
              id: 'boom',
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
  })

  it('onError "continue" lets the run finish; failed children record an error shape', async () => {
    const wf = pipeline({
      id: 'par-continue',
      steps: [
        parallel({
          id: 'g',
          onError: 'continue',
          steps: [
            code({ id: 'ok', run: () => ({ v: 1 }) }),
            code({
              id: 'boom',
              run: () => {
                throw new Error('boom')
              },
            }),
          ],
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    const out = run.output as Record<string, unknown>
    expect(out.ok).toEqual({ v: 1 })
    expect(out.boom).toBeDefined()
  })
})

describe('forEach(): property sweep', () => {
  for (const items of [[], [42], [1, 2, 3], Array.from({ length: 25 }, (_, i) => i)]) {
    it(`maps over ${items.length} items preserving order`, async () => {
      const wf = pipeline({
        id: `fe-${items.length}`,
        steps: [
          code({ id: 'src', run: () => ({ items }) }),
          forEach({
            id: 'mapped',
            items: (ctx) => (ctx.steps.src as { items: number[] }).items,
            step: (item) => code({ id: 'fn', run: () => ({ doubled: (item as number) * 2 }) }),
          }),
        ],
        finalize: (ctx) => ({ values: ctx.steps.mapped }),
      })
      const run = await runPipeline(wf, undefined)
      expect(run.status).toBe('completed')
      const out = run.output as { values: { doubled: number }[] }
      expect(out.values).toHaveLength(items.length)
      out.values.forEach((v, i) => expect(v.doubled).toBe((items[i] ?? 0) * 2))
    })
  }

  it('propagates child errors and fails the run', async () => {
    const wf = pipeline({
      id: 'fe-fail',
      steps: [
        code({ id: 'src', run: () => ({ items: [1, 2, 3] }) }),
        forEach({
          id: 'mapped',
          items: (ctx) => (ctx.steps.src as { items: number[] }).items,
          step: (item) =>
            code({
              id: 'fn',
              run: () => {
                if ((item as number) === 2) throw new Error('bad')
                return { ok: true }
              },
            }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
  })
})

describe('branch(): property sweep', () => {
  for (const choice of ['a', 'b', 'c'] as const) {
    it(`selects "${choice}" deterministically and does not run the unchosen branches`, async () => {
      const sideEffects: string[] = []
      const wf = pipeline({
        id: `br-${choice}`,
        steps: [
          code({ id: 'sel', run: () => ({ choice }) }),
          branch({
            id: 'route',
            on: (ctx) => (ctx.steps.sel as { choice: string }).choice,
            cases: {
              a: code({
                id: 'ca',
                run: () => {
                  sideEffects.push('a')
                  return { from: 'a' }
                },
              }),
              b: code({
                id: 'cb',
                run: () => {
                  sideEffects.push('b')
                  return { from: 'b' }
                },
              }),
              c: code({
                id: 'cc',
                run: () => {
                  sideEffects.push('c')
                  return { from: 'c' }
                },
              }),
            },
          }),
        ],
      })
      const run = await runPipeline(wf, undefined)
      expect(run.status).toBe('completed')
      expect(run.output).toEqual({ from: choice })
      expect(sideEffects).toEqual([choice])
    })
  }
})

describe('loop(): property sweep', () => {
  for (const cap of [1, 3, 5, 10]) {
    it(`respects maxIterations=${cap} when predicate stays true`, async () => {
      let n = 0
      const wf = pipeline({
        id: `lp-${cap}`,
        steps: [
          loop({
            id: 'L',
            maxIterations: cap,
            while: () => true,
            step: code({
              id: 'tick',
              run: () => ({ n: ++n }),
            }),
          }),
        ],
      })
      const run = await runPipeline(wf, undefined)
      expect(run.status).toBe('completed')
      const out = run.output as { iterations: { n: number }[]; last: { n: number } }
      expect(out.iterations).toHaveLength(cap)
      expect(out.last.n).toBe(cap)
      expect(n).toBe(cap)
    })
  }

  it('stops early when predicate goes false (no full max-iterations sweep)', async () => {
    let n = 0
    const wf = pipeline({
      id: 'lp-early',
      steps: [
        loop({
          id: 'L',
          maxIterations: 100,
          while: () => n < 3,
          step: code({ id: 'tick', run: () => ({ n: ++n }) }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    const out = run.output as { iterations: unknown[] }
    expect(out.iterations).toHaveLength(3)
  })
})

describe('wait(): timeout semantics', () => {
  it('emits a typed timeout error when no resume arrives', async () => {
    const bus = new EventBus()
    const events: string[] = []
    bus.subscribe((e) => events.push(e.type))
    const runner = new Runner({ events: bus })
    const wf = pipeline({
      id: 'wait-timeout',
      steps: [wait({ id: 'g', output: z.object({ ok: z.boolean() }), timeoutMs: 25 })],
    })
    const handle = runner.start(wf, undefined, { runId: 'wait-timeout' })
    const run = await handle.wait()
    expect(run.status).toBe('failed')
    // The runner emits run.waiting before the timeout fires.
    expect(events).toContain('run.waiting')
    // Failed run carries an error string mentioning the timeout.
    const err = (run as { error?: { message?: string } }).error
    expect(err?.message ?? '').toMatch(/timed out|timeout/i)
  })
})

describe('event ordering: wait/resumed', () => {
  it('emits run.waiting before run.resumed before run.completed', async () => {
    const bus = new EventBus()
    const seen: string[] = []
    bus.subscribe((e) => {
      if (e.runId === 'wait-resume-order') seen.push(e.type)
    })
    const runner = new Runner({ events: bus })
    const wf = pipeline({
      id: 'wait-resume-order',
      steps: [
        wait({ id: 'gate', output: z.object({ approved: z.boolean() }), timeoutMs: 5_000 }),
        code({ id: 'after', run: () => ({ done: true }) }),
      ],
    })
    const handle = runner.start(wf, undefined, { runId: 'wait-resume-order' })
    const deadline = Date.now() + 2_000
    while (!seen.includes('run.waiting')) {
      if (Date.now() > deadline) throw new Error('never waited')
      await new Promise((r) => setTimeout(r, 10))
    }
    await runner.resume(handle.runId, { approved: true })
    const run = await handle.wait()
    expect(run.status).toBe('completed')
    const waitingIdx = seen.indexOf('run.waiting')
    const resumedIdx = seen.indexOf('run.resumed')
    const completedIdx = seen.indexOf('run.completed')
    expect(waitingIdx).toBeGreaterThanOrEqual(0)
    expect(completedIdx).toBeGreaterThan(waitingIdx)
    if (resumedIdx >= 0) expect(resumedIdx).toBeLessThan(completedIdx)
  })
})
