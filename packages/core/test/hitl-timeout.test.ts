import { describe, expect, it } from 'vitest'
import { type HitlGate, Runner, code, pipeline } from '../src/index.js'

/**
 * HITL gate timeout → onTimeout behaviour. A gate that times out applies its
 * configured action (fail / approve / deny / escalate) rather than hanging the
 * run. Escalation re-pauses once under the escalation's assignees/target.
 */

function gatedPipeline(gate: HitlGate) {
  let bodyRan = false
  const wf = pipeline<undefined, { ran: boolean }>({
    id: `hitl-to-${gate.kind}-${gate.onTimeout}`,
    steps: [
      code({
        id: 's',
        humanInLoop: { beforeRun: gate },
        run: () => {
          bodyRan = true
          return { ran: true }
        },
      }),
    ],
    finalize: (ctx) => ctx.steps.s as { ran: boolean },
  })
  return { wf, ranRef: () => bodyRan }
}

describe('HITL gate timeout', () => {
  it('onTimeout:fail → run fails, body never runs', async () => {
    const { wf, ranRef } = gatedPipeline({ kind: 'approval', timeoutMs: 20, onTimeout: 'fail' })
    const run = await new Runner().start(wf, undefined).wait()
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('HitlDeniedError')
    expect(ranRef()).toBe(false)
  })

  it('onTimeout:approve → proceeds without a human', async () => {
    const { wf, ranRef } = gatedPipeline({ kind: 'approval', timeoutMs: 20, onTimeout: 'approve' })
    const run = await new Runner().start(wf, undefined).wait()
    expect(run.status).toBe('completed')
    expect(ranRef()).toBe(true)
  })

  it('onTimeout:deny → run fails (action blocked)', async () => {
    const { wf, ranRef } = gatedPipeline({ kind: 'approval', timeoutMs: 20, onTimeout: 'deny' })
    const run = await new Runner().start(wf, undefined).wait()
    expect(run.status).toBe('failed')
    expect(ranRef()).toBe(false)
  })

  it('onTimeout:escalate re-pauses then a human resolves the escalated gate', async () => {
    const { wf, ranRef } = gatedPipeline({
      kind: 'approval',
      timeoutMs: 20,
      onTimeout: 'escalate',
      escalation: { assignees: ['oncall'], deliveryTarget: '#oncall', timeoutMs: 10_000 },
    })
    const runner = new Runner()
    let waits = 0
    runner.events.subscribe((e) => {
      if (e.type === 'run.waiting') {
        waits++
        // Resolve only the SECOND (escalated) park, so the first must time out.
        if (waits === 2) {
          setImmediate(() => void runner.resume(e.runId, { kind: 'approval', approved: true }))
        }
      }
    })
    const run = await runner.start(wf, undefined).wait()
    expect(waits).toBe(2)
    expect(run.status).toBe('completed')
    expect(ranRef()).toBe(true)
  })
})
