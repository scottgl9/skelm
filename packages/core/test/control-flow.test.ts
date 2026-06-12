import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BackendRegistry, type SkelmBackend } from '../src/backend.js'
import {
  agent,
  branch,
  code,
  forEach,
  idempotent,
  loop,
  parallel,
  pipeline,
  pipelineStep,
  wait,
} from '../src/builders.js'
import { RunCancelledError } from '../src/errors.js'
import { Runner, runPipeline } from '../src/runner.js'

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

  it('rejects unsupported waitFor modes instead of silently ignoring them', () => {
    expect(() =>
      parallel({
        id: 'race',
        waitFor: 'any',
        steps: [code({ id: 'fast', run: () => ({}) }), code({ id: 'slow', run: () => ({}) })],
      }),
    ).toThrow(/waitFor="any" is not supported yet/)

    expect(() =>
      parallel({
        id: 'quorum',
        waitFor: { atLeast: 1 },
        steps: [code({ id: 'one', run: () => ({}) }), code({ id: 'two', run: () => ({}) })],
      }),
    ).toThrow(/waitFor=\{"atLeast":1\} is not supported yet/)
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

  it('rejects wait() nested directly inside parallel() at build time', () => {
    expect(() =>
      parallel({
        id: 'gather',
        steps: [code({ id: 'a', run: () => ({}) }), wait({ id: 'pause' })],
      }),
    ).toThrow(/wait\(pause\) is not allowed inside parallel/)
  })

  it('rejects wait() nested transitively (via pipelineStep) inside parallel()', () => {
    const inner = pipeline({
      id: 'inner-with-wait',
      steps: [wait({ id: 'gate' })],
    })
    expect(() =>
      parallel({
        id: 'race',
        steps: [
          code({ id: 'fast', run: () => ({}) }),
          pipelineStep({ id: 'slow', pipeline: inner }),
        ],
      }),
    ).toThrow(/wait\(gate\) is not allowed inside pipelineStep/)
  })

  it('rejects wait() nested transitively (via branch) inside parallel()', () => {
    // parallel() has concurrent arms — two waits could race to claim the
    // single-slot waitForInput entry. The error is attributed to parallel(),
    // even though the wait lives inside a branch child.
    expect(() =>
      parallel({
        id: 'gather',
        steps: [
          code({ id: 'a', run: () => ({}) }),
          branch({
            id: 'route',
            on: () => 'x',
            cases: { x: wait({ id: 'pause' }) },
          }),
        ],
      }),
    ).toThrow(/wait\(pause\) is not allowed inside parallel/)
  })

  it('allows wait() nested directly inside branch() at build time', () => {
    // branch() is safe: only one case executes, and the on() selector is
    // deterministic given the same input — after restart the runner takes the
    // same branch and reaches the same wait() without replaying side-effects
    // from other cases.
    expect(() =>
      branch({
        id: 'route',
        on: () => 'needs-review',
        cases: {
          'needs-review': wait({ id: 'human-approval' }),
          auto: code({ id: 'skip', run: () => ({}) }),
        },
      }),
    ).not.toThrow()
  })

  it('rejects wait() nested directly inside loop() at build time', () => {
    expect(() =>
      loop({
        id: 'retry',
        while: () => true,
        maxIterations: 1,
        step: wait({ id: 'pause' }),
      }),
    ).toThrow(/wait\(pause\) is not allowed inside loop/)
  })

  it('rejects wait() nested inside idempotent() at build time', () => {
    expect(() =>
      idempotent({
        id: 'once',
        key: 'approval',
        step: wait({ id: 'pause' }),
      }),
    ).toThrow(/wait\(pause\) is not allowed inside idempotent/)
  })

  it('rejects wait() nested inside pipelineStep() at build time', () => {
    const inner = pipeline({
      id: 'inner-approval',
      steps: [wait({ id: 'gate' })],
    })
    expect(() => pipelineStep({ id: 'nested', pipeline: inner })).toThrow(
      /wait\(gate\) is not allowed inside pipelineStep/,
    )
  })

  it('rejects wait() returned from forEach() step factories before executing it', async () => {
    const wf = pipeline({
      id: 'foreach-wait',
      steps: [
        forEach({
          id: 'each',
          items: () => [1],
          step: () => wait({ id: 'pause' }),
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.message).toMatch(/wait\(pause\) is not allowed inside forEach/)
  })
})

describe('forEach() egress token isolation (ISSUE-001)', () => {
  // The egress token bug: when forEach factory returns the same step id for
  // every iteration and concurrency > 1, the (runId, stepId) key passed to
  // registerEgressToken collides. The first iteration to complete calls
  // unregister and silently disables the token for sibling iterations still
  // in flight. We assert that the stepIds threaded through register/
  // unregister are distinct per iteration.

  async function captureEgressStepIds(opts: {
    factoryId: string
    items: readonly number[]
    concurrency?: number
  }): Promise<{ registered: string[]; unregistered: string[]; output: unknown }> {
    const registered: string[] = []
    const unregistered: string[] = []

    const backend: SkelmBackend = {
      id: 'mock',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      async run() {
        return { text: 'ok' }
      },
    }
    const registry = new BackendRegistry()
    registry.register(backend)

    const wf = pipeline({
      id: 'fe-egress',
      steps: [
        forEach({
          id: 'each',
          items: () => opts.items,
          ...(opts.concurrency !== undefined && { concurrency: opts.concurrency }),
          step: () =>
            agent({
              id: opts.factoryId,
              backend: 'mock',
              prompt: 'noop',
              permissions: { networkEgress: 'deny' },
            }),
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, {
      backends: registry,
      registerEgressToken: (runId, stepId) => {
        registered.push(stepId)
        return `${runId}:${stepId}`
      },
      unregisterEgressToken: (_runId, stepId) => {
        unregistered.push(stepId)
      },
    })
    expect(run.status).toBe('completed')
    return { registered, unregistered, output: run.output }
  }

  it('threads unique stepIds to register/unregister when concurrency > 1 and ids collide', async () => {
    const { registered, unregistered } = await captureEgressStepIds({
      factoryId: 'analyze',
      items: [1, 2, 3, 4],
      concurrency: 4,
    })
    expect(registered).toHaveLength(4)
    expect(new Set(registered).size).toBe(4)
    expect(registered.every((id) => /^analyze#\d+$/.test(id))).toBe(true)
    // Every registered token must be unregistered exactly once.
    expect([...unregistered].sort()).toEqual([...registered].sort())
  })

  it('does not rewrite ids when concurrency is 1 (no race possible)', async () => {
    const { registered, unregistered } = await captureEgressStepIds({
      factoryId: 'analyze',
      items: [1, 2],
    })
    expect(registered).toEqual(['analyze', 'analyze'])
    expect(unregistered).toEqual(['analyze', 'analyze'])
  })

  it('only suffixes ids that actually collide (mixed unique + duplicate factory ids)', async () => {
    // Factory returns ['a', 'b', 'b', 'c'] — only 'b' collides. The unique
    // 'a' and 'c' must keep their original ids; both 'b' instances get
    // suffixed with #i so the egress token keys are unique.
    const ids = ['a', 'b', 'b', 'c']
    const registered: string[] = []

    const backend: SkelmBackend = {
      id: 'mixed-mock',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      async run() {
        return { text: 'ok' }
      },
    }
    const registry = new BackendRegistry()
    registry.register(backend)

    const wf = pipeline({
      id: 'fe-mixed',
      steps: [
        forEach({
          id: 'each',
          items: () => ids,
          concurrency: 4,
          step: (item) =>
            agent({
              id: item as string,
              backend: 'mixed-mock',
              prompt: 'noop',
              permissions: { networkEgress: 'deny' },
            }),
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, {
      backends: registry,
      registerEgressToken: (runId, stepId) => {
        registered.push(stepId)
        return `${runId}:${stepId}`
      },
      unregisterEgressToken: () => {},
    })
    expect(run.status).toBe('completed')
    expect(registered.sort()).toEqual(['a', 'b#1', 'b#2', 'c'])
  })

  it('does not rewrite ids when factory returns unique ids per iteration', async () => {
    // Distinct factory ids; concurrency > 1 — no need to suffix.
    const registered: string[] = []
    const backend: SkelmBackend = {
      id: 'mock2',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      async run() {
        return { text: 'ok' }
      },
    }
    const registry = new BackendRegistry()
    registry.register(backend)

    const wf = pipeline({
      id: 'fe-unique-ids',
      steps: [
        forEach({
          id: 'each',
          items: () => [1, 2],
          concurrency: 2,
          step: (_item, i) =>
            agent({
              id: `worker-${i}`,
              backend: 'mock2',
              prompt: 'noop',
              permissions: { networkEgress: 'deny' },
            }),
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, {
      backends: registry,
      registerEgressToken: (runId, stepId) => {
        registered.push(stepId)
        return `${runId}:${stepId}`
      },
      unregisterEgressToken: () => {},
    })
    expect(run.status).toBe('completed')
    expect([...registered].sort()).toEqual(['worker-0', 'worker-1'])
  })
})

describe('parallel() shared-workspace warning (ISSUE-002)', () => {
  function makeMockBackend(): { backend: SkelmBackend; registry: BackendRegistry } {
    const backend: SkelmBackend = {
      id: 'ws-mock',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      async run() {
        return { text: 'ok' }
      },
    }
    const registry = new BackendRegistry()
    registry.register(backend)
    return { backend, registry }
  }

  it('emits run.warning for agent children with identical persistent workspace', async () => {
    const warnings: Array<{ code: string; message: string; stepId?: string }> = []
    const { registry } = makeMockBackend()

    const wf = pipeline({
      id: 'p-shared-agent-ws',
      steps: [
        parallel({
          id: 'twins',
          onError: 'continue',
          steps: [
            agent({
              id: 'left',
              backend: 'ws-mock',
              prompt: 'noop',
              workspace: { mode: 'persistent', name: 'shared' },
            }),
            agent({
              id: 'right',
              backend: 'ws-mock',
              prompt: 'noop',
              workspace: { mode: 'persistent', name: 'shared' },
            }),
          ],
        }),
      ],
    })

    const runner = new Runner({ backends: registry })
    runner.events.subscribe((event) => {
      if (event.type === 'run.warning') {
        warnings.push({ code: event.code, message: event.message, stepId: event.stepId })
      }
    })
    await runner.start(wf, undefined).wait()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe('parallel.shared-workspace')
    expect(warnings[0]?.stepId).toBe('twins')
    expect(warnings[0]?.message).toMatch(/left.*right|right.*left/)
  })

  it('does not warn when persistent workspaces have distinct names', async () => {
    const warnings: Array<{ code: string }> = []
    const { registry } = makeMockBackend()

    const wf = pipeline({
      id: 'p-distinct-ws',
      steps: [
        parallel({
          id: 'twins',
          onError: 'continue',
          steps: [
            agent({
              id: 'left',
              backend: 'ws-mock',
              prompt: 'noop',
              workspace: { mode: 'persistent', name: 'left' },
            }),
            agent({
              id: 'right',
              backend: 'ws-mock',
              prompt: 'noop',
              workspace: { mode: 'persistent', name: 'right' },
            }),
          ],
        }),
      ],
    })

    const runner = new Runner({ backends: registry })
    runner.events.subscribe((event) => {
      if (event.type === 'run.warning') warnings.push({ code: event.code })
    })
    await runner.start(wf, undefined).wait()
    expect(warnings).toEqual([])
  })

  it('emits parallel.workspace-resolve-failed when a workspace factory throws', async () => {
    const warnings: Array<{ code: string; message: string }> = []
    const { registry } = makeMockBackend()

    const wf = pipeline({
      id: 'p-ws-throw',
      steps: [
        parallel({
          id: 'twins',
          onError: 'continue',
          steps: [
            agent({
              id: 'left',
              backend: 'ws-mock',
              prompt: 'noop',
              workspace: () => {
                throw new Error('cannot resolve workspace name')
              },
            }),
            agent({
              id: 'right',
              backend: 'ws-mock',
              prompt: 'noop',
              workspace: { mode: 'persistent', name: 'right' },
            }),
          ],
        }),
      ],
    })

    const runner = new Runner({ backends: registry })
    runner.events.subscribe((event) => {
      if (event.type === 'run.warning') {
        warnings.push({ code: event.code, message: event.message })
      }
    })
    await runner.start(wf, undefined).wait()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe('parallel.workspace-resolve-failed')
    expect(warnings[0]?.message).toMatch(/child "left"/)
    expect(warnings[0]?.message).toMatch(/cannot resolve workspace name/)
  })

  it('does not warn for code() children (no workspace declarations)', async () => {
    const warnings: Array<{ code: string }> = []
    const wf = pipeline({
      id: 'p-code-only',
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
    const runner = new Runner()
    runner.events.subscribe((event) => {
      if (event.type === 'run.warning') warnings.push({ code: event.code })
    })
    const run = await runner.start(wf, undefined).wait()
    expect(run.status).toBe('completed')
    expect(warnings).toEqual([])
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
