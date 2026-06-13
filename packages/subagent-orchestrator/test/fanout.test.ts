import {
  type Context,
  type Pipeline,
  RunCancelledError,
  type WorkflowInvokeResult,
  code,
  pipeline,
} from '@skelm/core'
import { MemoryRunStore, runPipeline } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { fanOut, quorum, rankedMerge, runSubagents } from '../src/index.js'
import type { FanOutResult, SubagentInput } from '../src/index.js'

const registryOf = (map: Record<string, Pipeline>) => (id: string) => map[id]

// Deterministic, code-only child: echoes its input and scores it; an input
// containing "boom" throws so failure handling is exercised, and a slow input
// blocks until aborted so cancellation paths are observable.
const child = pipeline({
  id: 'child',
  steps: [
    code({
      id: 'work',
      run: (ctx) => {
        const input = ctx.input as { n?: number; mode?: 'boom' | 'slow' }
        if (input?.mode === 'boom') throw new Error('boom')
        if (input?.mode === 'slow') {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ n: input.n }), 3000)
            timer.unref?.()
            ctx.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                reject(new RunCancelledError())
              },
              { once: true },
            )
          })
        }
        return { n: input?.n }
      },
    }),
  ],
})

// Parent code() step that grants delegation to every child id and runs `body`.
function orchestrator(body: (ctx: Context) => unknown, delegation: string[] = ['*']): Pipeline {
  return pipeline({
    id: 'parent',
    steps: [code({ id: 'orchestrate', permissions: { delegation }, run: body })],
  })
}

async function runParent(
  body: (ctx: Context) => unknown,
  map: Record<string, Pipeline>,
  delegation?: string[],
) {
  const store = new MemoryRunStore()
  const parent = orchestrator(body, delegation)
  const run = await runPipeline(parent, undefined, { store, pipelineRegistry: registryOf(map) })
  return { run, store }
}

describe('fanOut', () => {
  it('fans across N children and returns the merged envelope with lineage', async () => {
    const { run } = await runParent(
      (ctx) =>
        fanOut<{ n: number }>(ctx, {
          tasks: [
            { workflowId: 'child', input: { n: 1 } },
            { workflowId: 'child', input: { n: 2 } },
            { workflowId: 'child', input: { n: 3 } },
          ],
        }),
      { child },
    )
    expect(run.status).toBe('completed')
    const out = run.output as FanOutResult<{ n: number }>
    expect(out.status).toBe('completed')
    expect(out.results.map((r) => r?.output?.n)).toEqual([1, 2, 3])
    expect(out.successes).toHaveLength(3)
    expect(out.failures).toHaveLength(0)
    // Lineage records parent → child linkage per settled child.
    expect(out.parentRunId).toBe(run.runId)
    expect(out.lineage).toHaveLength(3)
    for (const l of out.lineage) {
      expect(l.workflowId).toBe('child')
      expect(l.status).toBe('completed')
      expect(l.runId).toBeTruthy()
    }
  })

  it('respects the bounded concurrency', async () => {
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
            await new Promise((r) => setTimeout(r, 15))
            active--
            return 'done'
          },
        }),
      ],
    })
    const { run } = await runParent(
      (ctx) =>
        fanOut(ctx, {
          tasks: Array.from({ length: 6 }, () => ({ workflowId: 'tracked' as const })),
          concurrency: 2,
        }),
      { tracked },
    )
    expect(run.status).toBe('completed')
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('best-effort collects successes and records a failing child', async () => {
    const { run } = await runParent(
      (ctx) =>
        fanOut(ctx, {
          tasks: [
            { workflowId: 'child', input: { n: 1 } },
            { workflowId: 'child', input: { mode: 'boom' } },
            { workflowId: 'child', input: { n: 2 } },
          ],
          strategy: 'best-effort',
        }),
      { child },
    )
    expect(run.status).toBe('completed')
    const out = run.output as FanOutResult
    expect(out.status).toBe('completed')
    expect(out.successes).toHaveLength(2)
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0]?.error?.message).toContain('boom')
    expect(out.lineage.filter((l) => l.status === 'failed')).toHaveLength(1)
  })

  it('fail-fast aborts the remaining children on the first failure', async () => {
    const { run } = await runParent(
      async (ctx) => {
        try {
          await fanOut(ctx, {
            tasks: [
              { workflowId: 'child', input: { mode: 'boom' } },
              { workflowId: 'child', input: { mode: 'slow' } },
            ],
            strategy: 'fail-fast',
            concurrency: 2,
          })
          return 'no-throw'
        } catch (err) {
          const e = err as Error & { results?: readonly (WorkflowInvokeResult | undefined)[] }
          return { name: e.name, siblings: e.results?.map((r) => r?.status) }
        }
      },
      { child },
    )
    expect(run.status).toBe('completed')
    const out = run.output as { name: string; siblings: readonly (string | undefined)[] }
    expect(out.name).toBe('FanoutFailedError')
    expect(out.siblings[0]).toBe('failed')
    expect(out.siblings[1]).toBe('cancelled')
  })
})

describe('rankedMerge', () => {
  it('orders the settled results by the rank comparator and preserves lineage workflow ids', async () => {
    const childA = pipeline({
      id: 'childA',
      steps: child.steps,
    })
    const childB = pipeline({
      id: 'childB',
      steps: child.steps,
    })
    const { run } = await runParent(
      (ctx) =>
        rankedMerge<{ n: number }>(
          ctx,
          [
            { workflowId: 'childA', input: { n: 2 } },
            { workflowId: 'childB', input: { n: 9 } },
            { workflowId: 'childA', input: { n: 5 } },
          ],
          (a, b) => (b.output?.n ?? 0) - (a.output?.n ?? 0),
        ),
      { childA, childB },
    )
    expect(run.status).toBe('completed')
    const out = run.output as FanOutResult<{ n: number }>
    expect(out.results.map((r) => r?.output?.n)).toEqual([9, 5, 2])
    expect(out.lineage.map((r) => r.workflowId)).toEqual(['childB', 'childA', 'childA'])
  })
})

describe('quorum', () => {
  it('resolves once the threshold completes and cancels the rest', async () => {
    const { run } = await runParent(
      (ctx) =>
        quorum(
          ctx,
          [
            { workflowId: 'child', input: { n: 1 } },
            { workflowId: 'child', input: { n: 2 } },
            { workflowId: 'child', input: { mode: 'slow' } },
          ],
          2,
          { concurrency: 3 },
        ),
      { child },
    )
    expect(run.status).toBe('completed')
    const out = run.output as FanOutResult
    expect(out.status).toBe('completed')
    expect(out.successes.length).toBeGreaterThanOrEqual(2)
    expect(out.results[2]?.status === 'completed').toBe(false)
  })

  it('throws FanoutFailedError once the threshold is unreachable', async () => {
    const { run } = await runParent(
      async (ctx) => {
        try {
          await quorum(
            ctx,
            [
              { workflowId: 'child', input: { mode: 'boom' } },
              { workflowId: 'child', input: { n: 1 } },
            ],
            2,
          )
          return 'no-throw'
        } catch (err) {
          return (err as Error).name
        }
      },
      { child },
    )
    expect(run.output).toBe('FanoutFailedError')
  })
})

describe('runSubagents recipe', () => {
  it('threads role + lineage + budget into each child input', async () => {
    const captured: SubagentInput[] = []
    const capture = pipeline({
      id: 'capture',
      steps: [
        code({
          id: 'work',
          run: (ctx) => {
            captured.push(ctx.input as SubagentInput)
            return 'ok'
          },
        }),
      ],
    })
    const { run } = await runParent(
      (ctx) =>
        runSubagents(ctx, {
          role: 'coding',
          defaultBudget: { tokenBudget: 1000, maxToolCalls: 5 },
          children: [
            { workflowId: 'capture', input: { task: 'a' } },
            { workflowId: 'capture', input: { task: 'b' }, budget: { tokenBudget: 50 } },
          ],
        }),
      { capture },
    )
    expect(run.status).toBe('completed')
    expect(captured).toHaveLength(2)
    for (const env of captured) {
      expect(env.role).toBe('coding')
      expect(env.parentRunId).toBe(run.runId)
    }
    // Default budget applied to the first child; per-child budget overrides it.
    expect(captured[0]?.budget).toEqual({ tokenBudget: 1000, maxToolCalls: 5 })
    expect(captured[1]?.budget).toEqual({ tokenBudget: 50 })
  })
})
