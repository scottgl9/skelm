import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  EventBus,
  HitlConfigError,
  type HitlDecision,
  type HitlPolicy,
  MemoryRunStore,
  Runner,
  code,
  pipeline,
  runPipeline,
} from '../src/index.js'

/**
 * In-process HITL gate behavior. The Runner's wait/resume machinery backs the
 * gates: a gate pauses via the same `awaitResume` path as wait(), and
 * `runner.resume(runId, decision)` delivers a typed decision. These tests drive
 * each gate kind through approve/deny/input/edit/validate/choose/abort and the
 * required-gate-blocks and default-deny paths.
 */

/** Start a run and resolve its single pending gate once it parks. */
async function runWithResolution<I, O>(
  wf: ReturnType<typeof pipeline<I, O>>,
  input: I,
  decision: HitlDecision | unknown,
  opts: Parameters<Runner['start']>[2] = {},
) {
  const runner = new Runner()
  const parked = new Promise<{ runId: string }>((res) => {
    const unsub = runner.events.subscribe((e) => {
      if (e.type === 'run.waiting') {
        unsub()
        res({ runId: e.runId })
      }
    })
  })
  const handle = runner.start(wf, input, opts)
  parked.then(({ runId }) => {
    void runner.resume(runId, decision).catch(() => {})
  })
  return handle.wait()
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) items.push(item)
  return items
}

describe('HITL gates — beforeRun', () => {
  it('approval approve → proceeds', async () => {
    const wf = pipeline<undefined, { ran: boolean }>({
      id: 'hitl-approve',
      steps: [
        code({
          id: 's',
          humanInLoop: { beforeRun: { kind: 'approval', reason: 'go?' } },
          run: () => ({ ran: true }),
        }),
      ],
      finalize: (ctx) => ctx.steps.s as { ran: boolean },
    })
    const run = await runWithResolution(wf, undefined, { kind: 'approval', approved: true })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ ran: true })
  })

  it('approval deny → step does NOT run, run fails', async () => {
    let bodyRan = false
    const wf = pipeline<undefined, unknown>({
      id: 'hitl-deny',
      steps: [
        code({
          id: 's',
          humanInLoop: { beforeRun: { kind: 'approval' } },
          run: () => {
            bodyRan = true
            return { ran: true }
          },
        }),
      ],
    })
    const run = await runWithResolution(wf, undefined, {
      kind: 'approval',
      approved: false,
      reason: 'nope',
    })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('HitlDeniedError')
    expect(bodyRan).toBe(false)
  })

  it('input injects a value into ctx.hitl.input', async () => {
    const wf = pipeline<undefined, { echoed: number }>({
      id: 'hitl-input',
      steps: [
        code({
          id: 's',
          humanInLoop: { beforeRun: { kind: 'input', schema: z.number() } },
          run: (ctx) => ({ echoed: ctx.hitl?.input as number }),
        }),
      ],
      finalize: (ctx) => ctx.steps.s as { echoed: number },
    })
    const run = await runWithResolution(wf, undefined, { kind: 'input', value: 42 })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ echoed: 42 })
  })

  it('input rejects a schema-invalid value (run fails)', async () => {
    const wf = pipeline<undefined, unknown>({
      id: 'hitl-input-bad',
      steps: [
        code({
          id: 's',
          humanInLoop: { beforeRun: { kind: 'input', schema: z.number() } },
          run: (ctx) => ctx.hitl?.input,
        }),
      ],
    })
    const run = await runWithResolution(wf, undefined, { kind: 'input', value: 'not-a-number' })
    expect(run.status).toBe('failed')
  })

  it('run.resumed redacts input values in live and persisted events', async () => {
    const store = new MemoryRunStore()
    const events = new EventBus()
    const seen: unknown[] = []
    events.subscribe((event) => {
      if (event.type === 'run.resumed') seen.push(event.output)
    })
    const wf = pipeline<undefined, { echoed: string }>({
      id: 'hitl-input-redacted',
      steps: [
        code({
          id: 's',
          humanInLoop: { beforeRun: { kind: 'input', schema: z.string() } },
          run: (ctx) => ({ echoed: ctx.hitl?.input as string }),
        }),
      ],
      finalize: (ctx) => ctx.steps.s as { echoed: string },
    })
    const run = await runPipeline(wf, undefined, {
      events,
      store,
      waitForInput: async () => ({
        kind: 'input',
        value: 'top-secret',
        actor: 'alice',
        reason: 'provided',
      }),
    })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ echoed: 'top-secret' })
    expect(seen).toContainEqual({
      kind: 'input',
      redacted: true,
      actor: 'alice',
      reason: 'provided',
    })
    expect(seen).not.toContainEqual(
      expect.objectContaining({
        kind: 'input',
        value: 'top-secret',
      }),
    )
    const persisted = await collect(store.listEvents(run.runId))
    expect(persisted).toContainEqual(
      expect.objectContaining({
        type: 'run.resumed',
        output: {
          kind: 'input',
          redacted: true,
          actor: 'alice',
          reason: 'provided',
        },
      }),
    )
    expect(persisted).not.toContainEqual(
      expect.objectContaining({
        type: 'run.resumed',
        output: expect.objectContaining({
          value: 'top-secret',
        }),
      }),
    )
  })

  it('choose returns the selection into ctx.hitl.choose', async () => {
    const wf = pipeline<undefined, { picked: readonly string[] }>({
      id: 'hitl-choose',
      steps: [
        code({
          id: 's',
          humanInLoop: {
            beforeRun: {
              kind: 'choose',
              options: [{ id: 'a' }, { id: 'b' }],
            },
          },
          run: (ctx) => ({ picked: ctx.hitl?.choose as readonly string[] }),
        }),
      ],
      finalize: (ctx) => ctx.steps.s as { picked: readonly string[] },
    })
    const run = await runWithResolution(wf, undefined, { kind: 'choose', selected: ['b'] })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ picked: ['b'] })
  })

  it('retry-skip-abort skip → body skipped, run completes', async () => {
    let bodyRan = false
    const wf = pipeline<undefined, unknown>({
      id: 'hitl-skip',
      steps: [
        code({
          id: 's',
          humanInLoop: { beforeRun: { kind: 'retry-skip-abort' } },
          run: () => {
            bodyRan = true
            return { ran: true }
          },
        }),
      ],
    })
    const run = await runWithResolution(wf, undefined, { kind: 'retry-skip-abort', action: 'skip' })
    expect(run.status).toBe('completed')
    expect(bodyRan).toBe(false)
  })

  it('retry-skip-abort abort → run fails, body skipped', async () => {
    let bodyRan = false
    const wf = pipeline<undefined, unknown>({
      id: 'hitl-abort',
      steps: [
        code({
          id: 's',
          humanInLoop: { beforeRun: { kind: 'retry-skip-abort' } },
          run: () => {
            bodyRan = true
            return {}
          },
        }),
      ],
    })
    const run = await runWithResolution(wf, undefined, {
      kind: 'retry-skip-abort',
      action: 'abort',
    })
    expect(run.status).toBe('failed')
    expect(bodyRan).toBe(false)
  })
})

describe('HITL gates — afterOutput', () => {
  it('edit replaces the produced output', async () => {
    const wf = pipeline<undefined, { v: number }>({
      id: 'hitl-edit',
      steps: [
        code({
          id: 's',
          humanInLoop: { afterOutput: { kind: 'edit' } },
          run: () => ({ v: 1 }),
        }),
      ],
      finalize: (ctx) => ctx.steps.s as { v: number },
    })
    const run = await runWithResolution(wf, undefined, { kind: 'edit', value: { v: 999 } })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ v: 999 })
  })

  it('run.resumed redacts edit values in live and persisted events', async () => {
    const store = new MemoryRunStore()
    const events = new EventBus()
    const seen: unknown[] = []
    events.subscribe((event) => {
      if (event.type === 'run.resumed') seen.push(event.output)
    })
    const wf = pipeline<undefined, { v: number }>({
      id: 'hitl-edit-redacted',
      steps: [
        code({
          id: 's',
          humanInLoop: { afterOutput: { kind: 'edit' } },
          run: () => ({ v: 1 }),
        }),
      ],
      finalize: (ctx) => ctx.steps.s as { v: number },
    })
    const run = await runPipeline(wf, undefined, {
      events,
      store,
      waitForInput: async () => ({
        kind: 'edit',
        value: { v: 999 },
        actor: 'bob',
        reason: 'redacted',
      }),
    })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ v: 999 })
    expect(seen).toContainEqual({
      kind: 'edit',
      redacted: true,
      actor: 'bob',
      reason: 'redacted',
    })
    expect(seen).not.toContainEqual(
      expect.objectContaining({
        kind: 'edit',
        value: { v: 999 },
      }),
    )
    const persisted = await collect(store.listEvents(run.runId))
    expect(persisted).toContainEqual(
      expect.objectContaining({
        type: 'run.resumed',
        output: {
          kind: 'edit',
          redacted: true,
          actor: 'bob',
          reason: 'redacted',
        },
      }),
    )
    expect(persisted).not.toContainEqual(
      expect.objectContaining({
        type: 'run.resumed',
        output: expect.objectContaining({
          value: { v: 999 },
        }),
      }),
    )
  })

  it('validate accept → output passes through', async () => {
    const wf = pipeline<undefined, { v: number }>({
      id: 'hitl-validate-ok',
      steps: [
        code({
          id: 's',
          humanInLoop: { afterOutput: { kind: 'validate' } },
          run: () => ({ v: 7 }),
        }),
      ],
      finalize: (ctx) => ctx.steps.s as { v: number },
    })
    const run = await runWithResolution(wf, undefined, { kind: 'validate', accepted: true })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ v: 7 })
  })

  it('validate reject with onReject:fail → run fails', async () => {
    const wf = pipeline<undefined, unknown>({
      id: 'hitl-validate-fail',
      steps: [
        code({
          id: 's',
          humanInLoop: { afterOutput: { kind: 'validate', onReject: 'fail' } },
          run: () => ({ v: 1 }),
        }),
      ],
    })
    const run = await runWithResolution(wf, undefined, { kind: 'validate', accepted: false })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('HitlDeniedError')
  })

  it('validate reject with onReject:retry → body re-runs, then accept', async () => {
    let attempts = 0
    const wf = pipeline<undefined, { attempt: number }>({
      id: 'hitl-validate-retry',
      steps: [
        code({
          id: 's',
          humanInLoop: { afterOutput: { kind: 'validate', onReject: 'retry' } },
          run: () => ({ attempt: ++attempts }),
        }),
      ],
      finalize: (ctx) => ctx.steps.s as { attempt: number },
    })
    // Resolve the first park with reject, the second with accept.
    const runner = new Runner()
    let resolves = 0
    runner.events.subscribe((e) => {
      if (e.type === 'run.waiting') {
        const decision: HitlDecision =
          resolves++ === 0
            ? { kind: 'validate', accepted: false }
            : { kind: 'validate', accepted: true }
        // Defer so awaitResume has registered the pending before resume fires.
        setImmediate(() => void runner.resume(e.runId, decision).catch(() => {}))
      }
    })
    const run = await runner.start(wf, undefined).wait()
    expect(run.status).toBe('completed')
    expect(attempts).toBe(2)
    expect(run.output).toEqual({ attempt: 2 })
  })
})

describe('HITL gates — required + default-deny', () => {
  it('a required policy gate BLOCKS the body until resolved; approve proceeds', async () => {
    let bodyRan = false
    const policy: HitlPolicy = (ctx) =>
      ctx.phase === 'beforeRun' ? { kind: 'approval', reason: 'policy-required' } : undefined
    const wf = pipeline<undefined, { ran: boolean }>({
      id: 'hitl-required',
      steps: [
        code({
          id: 's',
          run: () => {
            bodyRan = true
            return { ran: true }
          },
        }),
      ],
      finalize: (ctx) => ctx.steps.s as { ran: boolean },
    })

    // Capture whether the body ran before resolution: it must not.
    const runner = new Runner()
    let observedBodyRanAtPark = true
    runner.events.subscribe((e) => {
      if (e.type === 'run.waiting' && e.hitl?.required === true) {
        observedBodyRanAtPark = bodyRan
        setImmediate(
          () => void runner.resume(e.runId, { kind: 'approval', approved: true }).catch(() => {}),
        )
      }
    })
    const run = await runner.start(wf, undefined, { hitlPolicy: policy }).wait()
    expect(observedBodyRanAtPark).toBe(false)
    expect(run.status).toBe('completed')
    expect(bodyRan).toBe(true)
  })

  it('a required policy gate denied → body never runs, run fails', async () => {
    let bodyRan = false
    const policy: HitlPolicy = () => ({ kind: 'approval' })
    const wf = pipeline<undefined, unknown>({
      id: 'hitl-required-deny',
      steps: [
        code({
          id: 's',
          run: () => {
            bodyRan = true
            return {}
          },
        }),
      ],
    })
    const run = await runWithResolution(
      wf,
      undefined,
      { kind: 'approval', approved: false, reason: 'blocked' },
      { hitlPolicy: policy },
    )
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('HitlDeniedError')
    expect(bodyRan).toBe(false)
  })

  it('default-deny: a gate with no wait/resume handler fails the step', async () => {
    const wf = pipeline<undefined, unknown>({
      id: 'hitl-no-handler',
      steps: [
        code({
          id: 's',
          humanInLoop: { beforeRun: { kind: 'approval' } },
          run: () => ({}),
        }),
      ],
    })
    // runPipeline with no waitForInput wired (bare, no Runner): the gate cannot
    // resolve, so the body must NOT run.
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe(HitlConfigError.name)
  })

  it('rejects beforeRun edit because it has no runtime effect', async () => {
    const wf = pipeline<undefined, unknown>({
      id: 'hitl-before-edit-unsupported',
      steps: [
        code({
          id: 's',
          humanInLoop: { beforeRun: { kind: 'edit' } },
          run: () => ({}),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('HitlUnsupportedGatePhaseError')
  })

  it('rejects afterOutput input because it has no runtime effect', async () => {
    const wf = pipeline<undefined, unknown>({
      id: 'hitl-after-input-unsupported',
      steps: [
        code({
          id: 's',
          humanInLoop: { afterOutput: { kind: 'input', schema: z.string() } },
          run: () => ({ ok: true }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('HitlUnsupportedGatePhaseError')
  })

  it('rejects afterOutput choose because it has no runtime effect', async () => {
    const wf = pipeline<undefined, unknown>({
      id: 'hitl-after-choose-unsupported',
      steps: [
        code({
          id: 's',
          humanInLoop: { afterOutput: { kind: 'choose', options: [{ id: 'a' }] } },
          run: () => ({ ok: true }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('HitlUnsupportedGatePhaseError')
  })

  it('a required policy gate cannot be bypassed by an author-declared gate', async () => {
    // The author declares a permissive choose gate; the policy injects a
    // required approval. The required gate must take precedence.
    const policy: HitlPolicy = () => ({ kind: 'approval', reason: 'override' })
    const wf = pipeline<undefined, unknown>({
      id: 'hitl-policy-wins',
      steps: [
        code({
          id: 's',
          humanInLoop: { beforeRun: { kind: 'choose', options: [{ id: 'a' }] } },
          run: () => ({}),
        }),
      ],
    })
    let observedKind: string | undefined
    const runner = new Runner()
    runner.events.subscribe((e) => {
      if (e.type === 'run.waiting' && e.hitl !== undefined) {
        observedKind = e.hitl.kind
        setImmediate(
          () => void runner.resume(e.runId, { kind: 'approval', approved: false }).catch(() => {}),
        )
      }
    })
    const run = await runner.start(wf, undefined, { hitlPolicy: policy }).wait()
    expect(observedKind).toBe('approval')
    expect(run.error?.name).toBe('HitlDeniedError')
  })
})
