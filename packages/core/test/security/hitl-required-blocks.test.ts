import { describe, expect, it } from 'vitest'
import { type HitlPolicy, Runner, code, pipeline } from '../../src/index.js'

/**
 * Adversarial: a policy-required human-in-the-loop gate MUST block the gated
 * action until a human resolves it, and an explicit deny MUST stop the action.
 * Neither the body running before resolution, nor the body running on deny, is
 * acceptable — that would let a risky action bypass the required gate.
 */
describe('security: required HITL gate cannot be bypassed', () => {
  it('the privileged body does not run until the gate is resolved, and deny blocks it', async () => {
    let bodyRan = false
    // Policy that REQUIRES approval for any step (stands in for "risky tool /
    // production env / network egress" conditions).
    const policy: HitlPolicy = () => ({ kind: 'approval', reason: 'policy-required' })
    const wf = pipeline<undefined, unknown>({
      id: 'sec-hitl-required',
      steps: [
        code({
          id: 'privileged',
          run: () => {
            bodyRan = true
            return { didPrivilegedThing: true }
          },
        }),
      ],
    })

    // 1) DENY: the body must NOT run.
    const denyRunner = new Runner()
    let observedRanAtPark = true
    denyRunner.events.subscribe((e) => {
      if (e.type === 'run.waiting' && e.hitl?.required === true) {
        observedRanAtPark = bodyRan
        setImmediate(
          () =>
            void denyRunner.resume(e.runId, { kind: 'approval', approved: false }).catch(() => {}),
        )
      }
    })
    const denied = await denyRunner.start(wf, undefined, { hitlPolicy: policy }).wait()
    expect(observedRanAtPark, 'body must not run before the gate resolves').toBe(false)
    expect(denied.status).toBe('failed')
    expect(denied.error?.name).toBe('HitlDeniedError')
    expect(bodyRan, 'body must not run after deny').toBe(false)

    // 2) APPROVE: the same gate, approved, lets the body run.
    bodyRan = false
    const okRunner = new Runner()
    okRunner.events.subscribe((e) => {
      if (e.type === 'run.waiting' && e.hitl?.required === true) {
        setImmediate(
          () => void okRunner.resume(e.runId, { kind: 'approval', approved: true }).catch(() => {}),
        )
      }
    })
    const approved = await okRunner.start(wf, undefined, { hitlPolicy: policy }).wait()
    expect(approved.status).toBe('completed')
    expect(bodyRan).toBe(true)
  })

  it('risk-driven policy fires when the risky grant comes from operator defaults, not the step', async () => {
    // Adversarial: the step declares NO permissions of its own; network egress
    // is granted by the operator's project defaults. A policy that requires a
    // gate iff the resolved step can egress MUST still fire — otherwise the
    // privileged action runs un-gated (the fail-open bug).
    let bodyRan = false
    const policy: HitlPolicy = (ctx) =>
      ctx.risk?.networkEgress === true ? { kind: 'approval', reason: 'egress' } : undefined
    const wf = pipeline<undefined, unknown>({
      id: 'sec-hitl-default-grant',
      steps: [
        code({
          id: 'egress-step',
          // No `permissions` here — the grant comes from defaultPermissions.
          run: () => {
            bodyRan = true
            return { sent: true }
          },
        }),
      ],
    })

    const runner = new Runner()
    let required = false
    let bodyRanAtPark = true
    runner.events.subscribe((e) => {
      if (e.type === 'run.waiting' && e.hitl?.required === true) {
        required = true
        bodyRanAtPark = bodyRan
        setImmediate(
          () => void runner.resume(e.runId, { kind: 'approval', approved: false }).catch(() => {}),
        )
      }
    })
    const result = await runner
      .start(wf, undefined, {
        hitlPolicy: policy,
        defaultPermissions: { networkEgress: 'allow' },
      })
      .wait()

    expect(required, 'risk.networkEgress from operator defaults must require the gate').toBe(true)
    expect(bodyRanAtPark, 'body must not run before the gate resolves').toBe(false)
    expect(result.status).toBe('failed')
    expect(result.error?.name).toBe('HitlDeniedError')
    expect(bodyRan, 'denied egress action must never run').toBe(false)
  })

  it('a required gate with no resolver fails the step (default-deny), never proceeds', async () => {
    let bodyRan = false
    const policy: HitlPolicy = () => ({ kind: 'approval' })
    const wf = pipeline<undefined, unknown>({
      id: 'sec-hitl-no-resolver',
      steps: [
        code({
          id: 'privileged',
          run: () => {
            bodyRan = true
            return {}
          },
        }),
      ],
    })
    // runPipeline with no waitForInput handler wired: the required gate cannot
    // resolve, so the body MUST NOT run.
    const { runPipeline } = await import('../../src/index.js')
    const run = await runPipeline(wf, undefined, { hitlPolicy: policy })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('HitlConfigError')
    expect(bodyRan).toBe(false)
  })
})
