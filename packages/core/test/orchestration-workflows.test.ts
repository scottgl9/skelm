import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import { RunCancelledError } from '../src/errors.js'
import type { Context, Pipeline, WorkflowFanoutResult, WorkflowInvokeResult } from '../src/index.js'
import { MemoryRunStore } from '../src/run-store.js'
import { runPipeline } from '../src/runner.js'

const registryOf = (map: Record<string, Pipeline>) => (id: string) => map[id]

const echo = pipeline({
  id: 'echo',
  steps: [code({ id: 'reply', run: (ctx) => ({ echoed: ctx.input }) })],
})

const boom = pipeline({
  id: 'boom',
  steps: [
    code({
      id: 'explode',
      run: () => {
        throw new Error('boom')
      },
    }),
  ],
})

// Resolves only when aborted (rejecting RunCancelledError) or after 3 s.
const slow = pipeline({
  id: 'slow',
  steps: [
    code({
      id: 'sleep',
      run: (ctx) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve('slow-done'), 3000)
          timer.unref?.()
          ctx.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new RunCancelledError())
            },
            { once: true },
          )
        }),
    }),
  ],
})

function orchestrator(run: (ctx: Context) => unknown) {
  return pipeline({
    id: 'parent',
    steps: [
      code({
        id: 'orchestrate',
        permissions: { delegation: ['*'] },
        run,
      }),
    ],
  })
}

describe('ctx.workflows.invoke', () => {
  it('returns a completed envelope with the child output and records lineage', async () => {
    const store = new MemoryRunStore()
    const parent = orchestrator((ctx) => ctx.workflows?.invoke({ pipelineId: 'echo', input: 41 }))
    const run = await runPipeline(parent, undefined, {
      store,
      pipelineRegistry: registryOf({ echo }),
    })
    expect(run.status).toBe('completed')
    const envelope = run.output as WorkflowInvokeResult<{ echoed: number }>
    expect(envelope.status).toBe('completed')
    expect(envelope.output).toEqual({ echoed: 41 })
    expect(envelope.runId).toBeTruthy()
    const childRun = await store.getRun(envelope.runId)
    expect(childRun?.parentRunId).toBe(run.runId)
    expect(childRun?.parentStepId).toBe('orchestrate')
  })

  it('returns a failed envelope carrying the child error', async () => {
    const parent = orchestrator((ctx) => ctx.workflows?.invoke({ pipelineId: 'boom' }))
    const run = await runPipeline(parent, undefined, { pipelineRegistry: registryOf({ boom }) })
    expect(run.status).toBe('completed')
    const envelope = run.output as WorkflowInvokeResult
    expect(envelope.status).toBe('failed')
    expect(envelope.error?.message).toContain('boom')
  })

  it('throws InvokePipelineNotFoundError for an unknown pipelineId', async () => {
    const parent = orchestrator((ctx) => ctx.workflows?.invoke({ pipelineId: 'missing' }))
    const run = await runPipeline(parent, undefined, { pipelineRegistry: registryOf({}) })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('InvokePipelineNotFoundError')
  })

  it('is absent when no pipeline registry is wired', async () => {
    const parent = pipeline({
      id: 'bare',
      steps: [code({ id: 'check', run: (ctx) => ctx.workflows === undefined })],
    })
    const run = await runPipeline(parent, undefined, {})
    expect(run.status).toBe('completed')
    expect(run.output).toBe(true)
  })
})

describe('ctx.workflows.fanout strategies', () => {
  it('wait-all: returns index-aligned results when every child completes', async () => {
    const parent = orchestrator((ctx) =>
      ctx.workflows?.fanout({ pipelineId: 'echo', inputs: [1, 2, 3] }),
    )
    const run = await runPipeline(parent, undefined, { pipelineRegistry: registryOf({ echo }) })
    expect(run.status).toBe('completed')
    const out = run.output as WorkflowFanoutResult<{ echoed: number }>
    expect(out.status).toBe('completed')
    expect(out.results.map((r) => r?.output?.echoed)).toEqual([1, 2, 3])
    expect(out.successes).toHaveLength(3)
    expect(out.failures).toHaveLength(0)
  })

  it('wait-all: throws FanoutFailedError when a child fails (no continueOnError)', async () => {
    const parent = orchestrator(async (ctx) => {
      try {
        await ctx.workflows?.fanout({
          items: [{ pipelineId: 'echo', input: 1 }, { pipelineId: 'boom' }],
        })
        return 'no-throw'
      } catch (err) {
        return (err as Error).name
      }
    })
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ echo, boom }),
    })
    expect(run.status).toBe('completed')
    expect(run.output).toBe('FanoutFailedError')
  })

  it('wait-all with continueOnError: records failures instead of throwing', async () => {
    const parent = orchestrator((ctx) =>
      ctx.workflows?.fanout({
        items: [{ pipelineId: 'echo', input: 1 }, { pipelineId: 'boom' }],
        continueOnError: true,
      }),
    )
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ echo, boom }),
    })
    expect(run.status).toBe('completed')
    const out = run.output as WorkflowFanoutResult
    expect(out.status).toBe('failed')
    expect(out.successes).toHaveLength(1)
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0]?.error?.message).toContain('boom')
  })

  it('fail-fast: first failure cancels in-flight siblings and rejects', async () => {
    const parent = orchestrator(async (ctx) => {
      try {
        await ctx.workflows?.fanout({
          items: [{ pipelineId: 'boom' }, { pipelineId: 'slow' }],
          strategy: 'fail-fast',
          concurrency: 2,
        })
        return 'no-throw'
      } catch (err) {
        const e = err as Error & { results?: readonly (WorkflowInvokeResult | undefined)[] }
        return {
          name: e.name,
          siblings: e.results?.map((r) => r?.status),
        }
      }
    })
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ boom, slow }),
    })
    expect(run.status).toBe('completed')
    const out = run.output as { name: string; siblings: readonly (string | undefined)[] }
    expect(out.name).toBe('FanoutFailedError')
    expect(out.siblings[0]).toBe('failed')
    // The slow sibling was cancelled rather than running to completion.
    expect(out.siblings[1]).toBe('cancelled')
  })

  it('best-effort: collects successes and records failures without throwing', async () => {
    const parent = orchestrator((ctx) =>
      ctx.workflows?.fanout({
        items: [
          { pipelineId: 'echo', input: 'a' },
          { pipelineId: 'boom' },
          { pipelineId: 'echo', input: 'b' },
        ],
        strategy: 'best-effort',
      }),
    )
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ echo, boom }),
    })
    expect(run.status).toBe('completed')
    const out = run.output as WorkflowFanoutResult<{ echoed: string }>
    expect(out.status).toBe('completed')
    expect(out.successes.map((r) => r.output?.echoed).sort()).toEqual(['a', 'b'])
    expect(out.failures).toHaveLength(1)
  })

  it('quorum: resolves when N children complete and cancels the rest', async () => {
    const parent = orchestrator((ctx) =>
      ctx.workflows?.fanout({
        items: [
          { pipelineId: 'echo', input: 1 },
          { pipelineId: 'echo', input: 2 },
          { pipelineId: 'slow' },
        ],
        strategy: 'quorum',
        quorum: 2,
        concurrency: 3,
      }),
    )
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ echo, slow }),
    })
    expect(run.status).toBe('completed')
    const out = run.output as WorkflowFanoutResult
    expect(out.status).toBe('completed')
    expect(out.successes.length).toBeGreaterThanOrEqual(2)
    // The slow child did not complete: it was cancelled (or never started).
    const slowResult = out.results[2]
    expect(slowResult?.status === 'completed').toBe(false)
  })

  it('quorum: throws FanoutFailedError when the quorum is unreachable', async () => {
    const parent = orchestrator(async (ctx) => {
      try {
        await ctx.workflows?.fanout({
          items: [{ pipelineId: 'boom' }, { pipelineId: 'echo', input: 1 }],
          strategy: 'quorum',
          quorum: 2,
        })
        return 'no-throw'
      } catch (err) {
        return (err as Error).name
      }
    })
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ echo, boom }),
    })
    expect(run.output).toBe('FanoutFailedError')
  })

  it('first-success: resolves on the first completed child and cancels the rest', async () => {
    const parent = orchestrator((ctx) =>
      ctx.workflows?.fanout({
        items: [{ pipelineId: 'slow' }, { pipelineId: 'echo', input: 'winner' }],
        strategy: 'first-success',
        concurrency: 2,
      }),
    )
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ echo, slow }),
    })
    expect(run.status).toBe('completed')
    const out = run.output as WorkflowFanoutResult<{ echoed: string }>
    expect(out.status).toBe('completed')
    expect(out.successes).toHaveLength(1)
    expect(out.successes[0]?.output?.echoed).toBe('winner')
    expect(out.results[0]?.status === 'completed').toBe(false)
  })

  it('first-success: throws FanoutFailedError when every child fails', async () => {
    const parent = orchestrator(async (ctx) => {
      try {
        await ctx.workflows?.fanout({
          items: [{ pipelineId: 'boom' }, { pipelineId: 'boom' }],
          strategy: 'first-success',
        })
        return 'no-throw'
      } catch (err) {
        return (err as Error).name
      }
    })
    const run = await runPipeline(parent, undefined, { pipelineRegistry: registryOf({ boom }) })
    expect(run.output).toBe('FanoutFailedError')
  })

  it('ranked-merge: orders all settled results with the rank comparator', async () => {
    const parent = orchestrator((ctx) =>
      ctx.workflows?.fanout({
        pipelineId: 'echo',
        inputs: [2, 9, 5],
        strategy: 'ranked-merge',
        rank: (a, b) =>
          ((b.output as { echoed: number })?.echoed ?? 0) -
          ((a.output as { echoed: number })?.echoed ?? 0),
      }),
    )
    const run = await runPipeline(parent, undefined, { pipelineRegistry: registryOf({ echo }) })
    expect(run.status).toBe('completed')
    const out = run.output as WorkflowFanoutResult<{ echoed: number }>
    expect(out.status).toBe('completed')
    expect(out.results.map((r) => r?.output?.echoed)).toEqual([9, 5, 2])
  })

  it('respects the concurrency bound', async () => {
    let active = 0
    let peak = 0
    const tracked = pipeline({
      id: 'tracked',
      steps: [
        code({
          id: 'work',
          run: async () => {
            active++
            peak = Math.max(peak, active)
            await new Promise((resolve) => setTimeout(resolve, 15))
            active--
            return 'done'
          },
        }),
      ],
    })
    const parent = orchestrator((ctx) =>
      ctx.workflows?.fanout({ pipelineId: 'tracked', inputs: [1, 2, 3, 4, 5, 6], concurrency: 2 }),
    )
    const run = await runPipeline(parent, undefined, { pipelineRegistry: registryOf({ tracked }) })
    expect(run.status).toBe('completed')
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('rejects invalid configurations with FanoutConfigError', async () => {
    const parent = orchestrator(async (ctx) => {
      const names: string[] = []
      const attempts: Array<() => Promise<unknown> | undefined> = [
        () => ctx.workflows?.fanout({}),
        () => ctx.workflows?.fanout({ pipelineId: 'echo', inputs: [] }),
        () => ctx.workflows?.fanout({ pipelineId: 'echo', inputs: [1], items: [] }),
        () => ctx.workflows?.fanout({ pipelineId: 'echo', inputs: [1], strategy: 'quorum' }),
        () =>
          ctx.workflows?.fanout({ pipelineId: 'echo', inputs: [1], strategy: 'quorum', quorum: 5 }),
        () => ctx.workflows?.fanout({ pipelineId: 'echo', inputs: [1], strategy: 'ranked-merge' }),
        () => ctx.workflows?.fanout({ pipelineId: 'echo', inputs: [1], concurrency: 0 }),
      ]
      for (const attempt of attempts) {
        try {
          await attempt()
          names.push('no-throw')
        } catch (err) {
          names.push((err as Error).name)
        }
      }
      return names
    })
    const run = await runPipeline(parent, undefined, { pipelineRegistry: registryOf({ echo }) })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual([
      'FanoutConfigError',
      'FanoutConfigError',
      'FanoutConfigError',
      'FanoutConfigError',
      'FanoutConfigError',
      'FanoutConfigError',
      'FanoutConfigError',
    ])
  })
})
