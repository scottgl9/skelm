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
