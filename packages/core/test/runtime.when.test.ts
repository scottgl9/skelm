import { describe, expect, it } from 'vitest'
import { agent, code, forEach, parallel, pipeline, pipelineStep } from '../src/builders.js'
import { EventBus, type RunEvent } from '../src/events.js'
import { runPipeline } from '../src/runner.js'

describe('runtime — when predicate', () => {
  it('runs the step when the predicate returns true', async () => {
    const ran: string[] = []
    const wf = pipeline({
      id: 'when-true',
      steps: [
        code({
          id: 'gated',
          when: () => true,
          run: () => {
            ran.push('gated')
            return { ok: true }
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(ran).toEqual(['gated'])
    expect(run.steps[0]?.status).toBe('completed')
  })

  it('skips the step when the predicate returns false', async () => {
    const ran: string[] = []
    const wf = pipeline({
      id: 'when-false',
      steps: [
        code({ id: 'first', run: () => ({ value: 1 }) }),
        code({
          id: 'gated',
          when: (ctx) => (ctx.get<{ value: number }>('first')?.value ?? 0) > 99,
          run: () => {
            ran.push('gated')
            return { ok: true }
          },
        }),
        code({
          id: 'after',
          run: (ctx) => ({
            gatedSeen: ctx.get('gated'),
          }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(ran).toEqual([])
    const gated = run.steps.find((s) => s.id === 'gated')
    expect(gated?.status).toBe('skipped')
    expect(gated?.output).toBeUndefined()
    // Later steps see the skipped step's output as undefined via ctx.get.
    expect(run.steps.find((s) => s.id === 'after')?.output).toEqual({ gatedSeen: undefined })
  })

  it('supports async predicates', async () => {
    const wf = pipeline({
      id: 'when-async',
      steps: [
        code({
          id: 'gated',
          when: async () => {
            await new Promise((r) => setTimeout(r, 1))
            return false
          },
          run: () => ({}),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.steps[0]?.status).toBe('skipped')
  })

  it('publishes a step.skipped event with the step kind, and no step.start', async () => {
    const events: RunEvent[] = []
    const bus = new EventBus()
    bus.subscribe((e) => events.push(e))
    const wf = pipeline({
      id: 'when-event',
      steps: [code({ id: 'gated', when: () => false, run: () => ({}) })],
    })
    await runPipeline(wf, undefined, { events: bus })
    const skipped = events.find((e) => e.type === 'step.skipped')
    expect(skipped).toBeDefined()
    if (skipped?.type === 'step.skipped') {
      expect(skipped.stepId).toBe('gated')
      expect(skipped.kind).toBe('code')
    }
    expect(events.find((e) => e.type === 'step.start' && e.stepId === 'gated')).toBeUndefined()
  })

  it('treats a predicate exception as a step failure', async () => {
    const wf = pipeline({
      id: 'when-throws',
      steps: [
        code({
          id: 'gated',
          when: () => {
            throw new Error('predicate boom')
          },
          run: () => ({}),
        }),
        code({ id: 'never', run: () => ({ reached: true }) }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    const gated = run.steps.find((s) => s.id === 'gated')
    expect(gated?.status).toBe('failed')
    expect(gated?.error?.message).toBe('predicate boom')
    // Subsequent steps must not run.
    expect(run.steps.find((s) => s.id === 'never')).toBeUndefined()
  })

  it('works on pipelineStep — skipping a nested pipeline', async () => {
    const inner = pipeline({
      id: 'inner',
      steps: [code({ id: 'work', run: () => ({ ran: true }) })],
    })
    const wf = pipeline({
      id: 'outer',
      steps: [
        pipelineStep({
          id: 'nested',
          pipeline: inner,
          when: () => false,
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.steps[0]?.status).toBe('skipped')
  })

  it('evaluates `when` on steps nested inside parallel() and emits step.skipped', async () => {
    const ran: string[] = []
    const events: RunEvent[] = []
    const bus = new EventBus()
    bus.subscribe((e) => events.push(e))
    const wf = pipeline({
      id: 'nested-when',
      steps: [
        parallel({
          id: 'fan',
          steps: [
            code({
              id: 'a',
              run: () => {
                ran.push('a')
                return {}
              },
            }),
            code({
              id: 'skip-me',
              when: () => false,
              run: () => {
                ran.push('skip-me')
                return {}
              },
            }),
          ],
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { events: bus })
    expect(run.status).toBe('completed')
    expect(ran).toEqual(['a'])
    expect(events.some((e) => e.type === 'step.skipped' && e.stepId === 'skip-me')).toBe(true)
  })

  it('evaluates `when` on each forEach() child independently', async () => {
    const ran: number[] = []
    const wf = pipeline({
      id: 'foreach-when',
      steps: [
        forEach({
          id: 'each',
          items: () => [1, 2, 3, 4],
          step: (item, i) =>
            code({
              id: `child-${i}`,
              when: () => (item as number) % 2 === 0,
              run: () => {
                ran.push(item as number)
                return item
              },
            }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(ran).toEqual([2, 4])
  })

  it('agent() accepts a when predicate at the type level', () => {
    // Compile-time: build an agent step with `when`. We do not run it here
    // (the test would require a backend); just ensuring the field is accepted.
    const step = agent({
      id: 'a',
      prompt: 'hi',
      when: () => false,
    })
    expect(step.when).toBeTypeOf('function')
  })
})
