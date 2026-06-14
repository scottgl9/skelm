import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../../src/builders.js'
import type { AuditEvent, AuditWriter } from '../../src/enforcement/index.js'
import { EventBus, type RunEvent } from '../../src/events.js'
import type {
  GuardrailsConfig,
  InterventionRequest,
  PostRunValidator,
  PreRunValidator,
  SupervisorHook,
} from '../../src/guardrails.js'
import { Runner } from '../../src/runner.js'
import { runPipeline } from '../../src/runner.js'

class CapturingAuditWriter implements AuditWriter {
  readonly entries: AuditEvent[] = []
  async write(entry: AuditEvent): Promise<void> {
    this.entries.push(entry)
  }
}

function trivial(id = 'work', run: () => unknown = () => ({ ok: true })) {
  return code({ id, run })
}

describe('guardrails: pre-run validators (fail closed)', () => {
  it('a HARD pre-run failure BLOCKS the run start — the step body never runs', async () => {
    let bodyRan = false
    const blocking: PreRunValidator = {
      id: 'policy-check',
      validate: () => ({ check: 'policy-check', status: 'fail', message: 'package not trusted' }),
    }
    const wf = pipeline({
      id: 'wf-prerun-block',
      guardrails: { preRun: [blocking] },
      steps: [
        trivial('priv', () => {
          bodyRan = true
          return {}
        }),
      ],
    })
    const events: RunEvent[] = []
    const bus = new EventBus()
    bus.subscribe((e) => events.push(e))
    const run = await runPipeline(wf, undefined, { events: bus })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('GuardrailBlockedError')
    expect(bodyRan, 'a blocked pre-run check must prevent any step from running').toBe(false)
    expect(run.guardrail?.failed).toBe(true)
    // No step.start was ever published — the run was blocked before the loop.
    expect(events.some((e) => e.type === 'step.start')).toBe(false)
    const pre = events.filter((e) => e.type === 'guardrail.pre')
    expect(pre).toHaveLength(1)
  })

  it('a throwing pre-run validator fails closed (treated as a hard fail)', async () => {
    let bodyRan = false
    const thrower: PreRunValidator = {
      id: 'explode',
      validate: () => {
        throw new Error('validator crashed')
      },
    }
    const wf = pipeline({
      id: 'wf-prerun-throw',
      guardrails: { preRun: [thrower] },
      steps: [
        trivial('priv', () => {
          bodyRan = true
          return {}
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('GuardrailBlockedError')
    expect(bodyRan).toBe(false)
  })

  it('a SOFT pre-run failure warns and the run proceeds', async () => {
    let bodyRan = false
    const soft: PreRunValidator = {
      id: 'advisory',
      severity: 'soft',
      validate: () => ({ check: 'advisory', status: 'fail', message: 'minor concern' }),
    }
    const wf = pipeline({
      id: 'wf-prerun-soft',
      guardrails: { preRun: [soft] },
      steps: [
        trivial('priv', () => {
          bodyRan = true
          return { done: true }
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(bodyRan).toBe(true)
  })

  it('an adversarial step cannot bypass a hard pre-run check — first step never starts', async () => {
    const order: string[] = []
    const blocking: PreRunValidator = {
      id: 'gate',
      validate: () => {
        order.push('pre')
        return { check: 'gate', status: 'fail' }
      },
    }
    const wf = pipeline({
      id: 'wf-prerun-adversarial',
      guardrails: { preRun: [blocking] },
      steps: [
        trivial('eager', () => {
          order.push('step')
          return {}
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(order).toEqual(['pre'])
  })
})

describe('guardrails: in-run budgets & oversight', () => {
  it('a token budget breach triggers the configured terminate intervention', async () => {
    const wf = pipeline({
      id: 'wf-budget-terminate',
      guardrails: {
        budget: { tokenBudget: 100 },
        budgetOnBreach: 'terminate',
      },
      steps: [
        // Agent-shaped output carrying usage; the runner folds it into the budget.
        code({ id: 'turn1', run: () => ({ usage: { inputTokens: 80, outputTokens: 80 } }) }),
        code({ id: 'turn2', run: () => ({ ran: true }) }),
      ],
    })
    const events: RunEvent[] = []
    const bus = new EventBus()
    bus.subscribe((e) => events.push(e))
    const run = await runPipeline(wf, undefined, { events: bus })

    expect(run.status).toBe('cancelled')
    const intervention = events.find((e) => e.type === 'guardrail.intervention')
    expect(intervention).toBeDefined()
    expect(intervention?.type === 'guardrail.intervention' && intervention.action).toBe('terminate')
    expect(intervention?.type === 'guardrail.intervention' && intervention.source).toBe('budget')
    // turn2 must NOT have completed — the run was terminated after turn1's breach.
    expect(events.some((e) => e.type === 'step.complete' && e.stepId === 'turn2')).toBe(false)
    expect(run.guardrail?.interventions?.some((i) => i.action === 'terminate')).toBe(true)
  })

  it('a tool-call budget breach is observed from tool.call events', async () => {
    const wf = pipeline({
      id: 'wf-budget-toolcalls',
      guardrails: { budget: { maxToolCalls: 1 }, budgetOnBreach: 'terminate' },
      steps: [
        code({
          id: 'caller',
          permissions: { allowedExecutables: ['node'] },
          run: async (ctx) => {
            const exec = ctx.exec as (req: unknown) => Promise<unknown>
            await exec({ command: 'node', args: ['-e', 'process.stdout.write("a")'] })
            await exec({ command: 'node', args: ['-e', 'process.stdout.write("b")'] })
            return {}
          },
        }),
        code({ id: 'after', run: () => ({ ran: true }) }),
      ],
    })
    const events: RunEvent[] = []
    const bus = new EventBus()
    bus.subscribe((e) => events.push(e))
    const run = await runPipeline(wf, undefined, { events: bus })
    expect(run.status).toBe('cancelled')
    const intervention = events.find(
      (e) => e.type === 'guardrail.intervention' && e.source === 'budget',
    )
    expect(intervention).toBeDefined()
  })

  it('a supervisor requesting pause creates a HITL gate that blocks until resolved', async () => {
    const supervisor: SupervisorHook = (ctx) =>
      ctx.lastStepId === 'first'
        ? ({ action: 'pause', reason: 'supervisor hold' } satisfies InterventionRequest)
        : undefined
    const wf = pipeline({
      id: 'wf-supervisor-pause',
      guardrails: { supervisor },
      steps: [trivial('first'), trivial('second')],
    })
    const runner = new Runner()
    const seen: RunEvent[] = []
    let resolvedWhilePaused = false
    runner.events.subscribe((e) => {
      seen.push(e)
      if (e.type === 'run.waiting' && e.stepId === 'first' && e.hitl?.required === true) {
        // The pause must block the run before 'second' completes.
        resolvedWhilePaused = !seen.some(
          (ev) => ev.type === 'step.complete' && ev.stepId === 'second',
        )
        setImmediate(
          () => void runner.resume(e.runId, { kind: 'approval', approved: true }).catch(() => {}),
        )
      }
    })
    const run = await runner.start(wf, undefined).wait()
    expect(resolvedWhilePaused, 'second step must not run while paused').toBe(true)
    expect(run.status).toBe('completed')
    const intervention = seen.find(
      (e) => e.type === 'guardrail.intervention' && e.source === 'supervisor',
    )
    expect(intervention).toBeDefined()
    expect(intervention?.type === 'guardrail.intervention' && intervention.action).toBe('pause')
  })

  it('a supervisor requesting terminate cancels the run', async () => {
    const supervisor: SupervisorHook = () => ({ action: 'terminate', reason: 'critic abort' })
    const wf = pipeline({
      id: 'wf-supervisor-terminate',
      guardrails: { supervisor },
      steps: [trivial('first'), trivial('second')],
    })
    const events: RunEvent[] = []
    const bus = new EventBus()
    bus.subscribe((e) => events.push(e))
    const run = await runPipeline(wf, undefined, { events: bus })
    expect(run.status).toBe('cancelled')
    expect(events.some((e) => e.type === 'step.complete' && e.stepId === 'second')).toBe(false)
  })

  it('a paused oversight gate with no resolver fails closed (terminates)', async () => {
    const supervisor: SupervisorHook = () => ({ action: 'pause', reason: 'hold' })
    const wf = pipeline({
      id: 'wf-supervisor-noresolver',
      guardrails: { supervisor },
      steps: [trivial('first'), trivial('second')],
    })
    // runPipeline with no waitForInput handler: the pause cannot block, so it
    // degrades to terminate rather than silently proceeding past the hold.
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('cancelled')
  })

  it('the watchdog fires on the maxRunMs bound', async () => {
    const wf = pipeline({
      id: 'wf-watchdog',
      guardrails: { watchdog: { maxRunMs: 5, onBreach: 'terminate' } },
      steps: [
        code({
          id: 'slow',
          run: async () => {
            await new Promise((r) => setTimeout(r, 25))
            return {}
          },
        }),
        trivial('after'),
      ],
    })
    const events: RunEvent[] = []
    const bus = new EventBus()
    bus.subscribe((e) => events.push(e))
    const run = await runPipeline(wf, undefined, { events: bus })
    expect(run.status).toBe('cancelled')
    const intervention = events.find(
      (e) => e.type === 'guardrail.intervention' && e.source === 'watchdog',
    )
    expect(intervention).toBeDefined()
  })
})

describe('guardrails: post-run validators', () => {
  it('a post-run hard failure marks the run guardrail-failed with a report', async () => {
    const checkOutput: PostRunValidator = {
      id: 'expected-behavior',
      validate: (ctx) => {
        const out = ctx.run.output as { ok?: boolean } | undefined
        return out?.ok === true
          ? { check: 'expected-behavior', status: 'pass' }
          : { check: 'expected-behavior', status: 'fail', message: 'output.ok was not true' }
      },
    }
    const wf = pipeline({
      id: 'wf-postrun-fail',
      guardrails: { postRun: [checkOutput] },
      finalize: () => ({ ok: false }),
      steps: [trivial('work')],
    })
    const events: RunEvent[] = []
    const bus = new EventBus()
    bus.subscribe((e) => events.push(e))
    const run = await runPipeline(wf, undefined, { events: bus })

    expect(run.status).toBe('failed')
    expect(run.guardrail?.failed).toBe(true)
    expect(
      run.guardrail?.results.some((r) => r.check === 'expected-behavior' && r.status === 'fail'),
    ).toBe(true)
    expect(events.some((e) => e.type === 'guardrail.post' && e.status === 'fail')).toBe(true)
  })

  it('a passing run is clean — post-run validators all pass, status completed', async () => {
    const checkOutput: PostRunValidator = {
      id: 'quality',
      validate: () => ({ check: 'quality', status: 'pass', score: 1 }),
    }
    const wf = pipeline({
      id: 'wf-postrun-pass',
      guardrails: { postRun: [checkOutput] },
      finalize: () => ({ ok: true }),
      steps: [trivial('work')],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(run.guardrail?.failed).toBe(false)
    expect(run.guardrail?.results.every((r) => r.status === 'pass')).toBe(true)
  })

  it('a soft post-run failure does not fail the run', async () => {
    const soft: PostRunValidator = {
      id: 'advisory',
      severity: 'soft',
      validate: () => ({ check: 'advisory', status: 'fail' }),
    }
    const wf = pipeline({
      id: 'wf-postrun-soft',
      guardrails: { postRun: [soft] },
      steps: [trivial('work')],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(run.guardrail?.failed).toBe(false)
  })
})

describe('guardrails: audit visibility (no secret leak)', () => {
  it('every guardrail decision and intervention is audited, and no secret value leaks', async () => {
    const SECRET = 'super-secret-token-value'
    const pre: PreRunValidator = {
      id: 'pre',
      severity: 'soft',
      // The validator inspects a secret internally but only reports a non-secret reason.
      validate: () => ({ check: 'pre', status: 'warn', message: 'looks ok' }),
    }
    const post: PostRunValidator = {
      id: 'post',
      validate: () => ({ check: 'post', status: 'pass', score: 0.9 }),
    }
    const supervisor: SupervisorHook = (ctx) =>
      ctx.lastStepId === 'work' ? { action: 'terminate', reason: 'budget concern' } : undefined
    const config: GuardrailsConfig = { preRun: [pre], supervisor, postRun: [post] }
    const wf = pipeline({
      id: 'wf-audit',
      guardrails: config,
      steps: [trivial('work', () => ({ token: SECRET }))],
    })
    const audit = new CapturingAuditWriter()
    const run = await runPipeline(wf, undefined, { auditWriter: audit })

    // terminate intervention → cancelled.
    expect(run.status).toBe('cancelled')
    const actions = audit.entries.map((e) => e.action)
    expect(actions).toContain('guardrail.pre')
    expect(actions).toContain('guardrail.intervention')
    // No audit entry may contain the secret value anywhere in its serialized form.
    const serialized = JSON.stringify(audit.entries)
    expect(serialized.includes(SECRET)).toBe(false)
  })
})

describe('guardrails: oversight fails closed + reports terminate accurately', () => {
  it('a THROWING supervisor terminates the run even on a continueOnError step (no silent bypass)', async () => {
    let secondRan = false
    const supervisor: SupervisorHook = (ctx) => {
      if (ctx.lastStepId === 'first') throw new Error('critic crashed')
      return undefined
    }
    const wf = pipeline({
      id: 'wf-supervisor-throws',
      guardrails: { supervisor },
      steps: [
        // continueOnError would let a mis-attributed supervisor crash be swallowed.
        code({ id: 'first', continueOnError: true, run: () => ({ ok: true }) }),
        code({
          id: 'second',
          run: () => {
            secondRan = true
            return { ok: true }
          },
        }),
      ],
    })
    const events: RunEvent[] = []
    const bus = new EventBus()
    bus.subscribe((e) => events.push(e))
    const run = await runPipeline(wf, undefined, { events: bus })

    expect(run.status).toBe('cancelled')
    const intervention = events.find(
      (e) => e.type === 'guardrail.intervention' && e.source === 'supervisor',
    )
    expect(intervention).toBeDefined()
    expect(intervention?.type === 'guardrail.intervention' && intervention.action).toBe('terminate')
    // Oversight was NOT silently dropped; the unsupervised step never ran.
    expect(secondRan).toBe(false)
    expect(run.guardrail?.interventions?.some((i) => i.action === 'terminate')).toBe(true)
  })

  it('a pause that degrades to termination (no resolver) is reported as a guardrail failure', async () => {
    const supervisor: SupervisorHook = (ctx) =>
      ctx.lastStepId === 'first'
        ? ({ action: 'pause', reason: 'supervisor hold' } satisfies InterventionRequest)
        : undefined
    const wf = pipeline({
      id: 'wf-pause-degrades',
      guardrails: { supervisor },
      steps: [trivial('first'), trivial('second')],
    })
    // No waitForInput wired: the pause cannot block, so it degrades to terminate.
    const run = await runPipeline(wf, undefined, {})

    expect(run.status).toBe('cancelled')
    // The degraded pause must be recorded as a terminate so `failed` is true —
    // the run WAS killed by oversight, not merely paused.
    expect(run.guardrail?.failed).toBe(true)
    expect(run.guardrail?.interventions?.some((i) => i.action === 'terminate')).toBe(true)
  })
})
