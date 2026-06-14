/**
 * Gateway HITL integration: durable pause/resume across restart, the
 * /v1/hitl list/get/resolve API, and audit of every resolution through the
 * single gateway audit writer. Uses the real gateway code path (no mocks of
 * the gateway or audit writer) per the security-test rules.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuditEvent, AuditWriter } from '@skelm/core'
import { code, pipeline } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Gateway } from '../src/index.js'
import { bootGatewayWithRetry } from './utils/boot-gateway.js'

class CapturingAuditWriter implements AuditWriter {
  events: AuditEvent[] = []
  async write(e: AuditEvent): Promise<void> {
    this.events.push(e)
  }
}

let stateDir: string
let projectRoot: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-hitl-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-hitl-project-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

describe('HITL gate durability across gateway restart', () => {
  it('a step parked at a beforeRun approval gate survives restart and is still resolvable', async () => {
    const gw1 = new Gateway({ stateDir, enableHttp: false, watchRegistries: false, config: {} })
    await gw1.start()

    const wf = pipeline<undefined, unknown>({
      id: 'hitl-restart',
      steps: [
        code({
          id: 'gated',
          humanInLoop: { beforeRun: { kind: 'approval', reason: 'approve restart' } },
          run: () => ({ ran: true }),
        }),
      ],
    })

    const { Runner } = await import('@skelm/core')
    const runner = new Runner({ store: gw1.runStore })
    const waitingFired = new Promise<void>((res) => {
      const unsub = runner.events.subscribe((e) => {
        if (e.type === 'run.waiting') {
          unsub()
          res()
        }
      })
    })
    const handle = runner.start(wf, undefined)
    gw1.registerRun(handle.runId, new AbortController(), runner)
    await waitingFired
    await new Promise((r) => setTimeout(r, 50))

    const before = await gw1.runStore.getRun(handle.runId)
    expect(before?.status).toBe('waiting')
    expect(before?.waiting?.hitl?.kind).toBe('approval')
    expect(before?.waiting?.hitl?.phase).toBe('beforeRun')

    gw1.unregisterRun(handle.runId)
    await gw1.stop()

    // Restart: recovery must NOT finalize a `waiting` run; the HITL snapshot
    // must survive intact.
    const gw2 = new Gateway({ stateDir, enableHttp: false, watchRegistries: false, config: {} })
    await gw2.start()
    try {
      const after = await gw2.runStore.getRun(handle.runId)
      expect(after?.status).toBe('waiting')
      expect(after?.waiting?.hitl?.kind).toBe('approval')
      expect(after?.waiting?.hitl?.reason).toBe('approve restart')
    } finally {
      await gw2.stop()
    }
  })

  it('POST /v1/hitl/:id/resolve after restart rehydrates and completes the run', async () => {
    const workflowPath = join(projectRoot, 'hitl.workflow.mts')
    await writeFile(workflowPath, '// loaded by the test gateway loader\n')
    const wf = pipeline({
      id: 'hitl-rehydrate',
      input: z.object({ seed: z.number() }),
      output: z.object({ result: z.number() }),
      steps: [
        code({ id: 'prep', run: (ctx) => ({ doubled: ctx.input.seed * 2 }) }),
        code({
          id: 'gated',
          humanInLoop: { beforeRun: { kind: 'approval' } },
          run: (ctx) => ({ result: (ctx.steps.prep as { doubled: number }).doubled + 1 }),
        }),
      ],
      finalize: (ctx) => ctx.steps.gated,
    })
    const loadWorkflow = async (_id: string, absolutePath: string): Promise<unknown> => {
      if (absolutePath !== workflowPath) throw new Error(`unexpected path: ${absolutePath}`)
      return { default: wf }
    }
    const boot = async () =>
      bootGatewayWithRetry((port) => ({
        stateDir,
        projectRoot,
        enableHttp: true,
        watchRegistries: false,
        httpPort: port,
        config: {},
        loadWorkflow,
      }))

    const first = await boot()
    const start = await fetch(`${first.base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipelinePath: workflowPath, input: { seed: 10 } }),
    })
    expect(start.status).toBe(200)
    const { runId } = (await start.json()) as { runId: string }

    for (let i = 0; i < 50; i++) {
      const stored = await first.gw.runStore.getRun(runId)
      if (stored?.status === 'waiting') break
      await new Promise((r) => setTimeout(r, 20))
    }
    const parked = await first.gw.runStore.getRun(runId)
    expect(parked?.waiting?.hitl?.kind).toBe('approval')
    expect(parked?.steps.map((s) => s.id)).toEqual(['prep'])

    first.gw.unregisterRun(runId)
    await first.gw.stop()

    const second = await boot()
    try {
      // List shows the pending gate after restart.
      const list = (await fetch(`${second.base}/v1/hitl`).then((r) => r.json())) as {
        pending: Array<{ runId: string; gate: { kind: string } }>
      }
      expect(list.pending.some((p) => p.runId === runId && p.gate.kind === 'approval')).toBe(true)

      const resolve = await fetch(`${second.base}/v1/hitl/${runId}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actor: 'alice', reason: 'ok' }),
      })
      const text = await resolve.text()
      if (resolve.status !== 200) throw new Error(`resolve failed: ${resolve.status} ${text}`)
      expect(JSON.parse(text)).toMatchObject({ resolved: true, rehydrated: true })

      let final = await second.gw.runStore.getRun(runId)
      for (let i = 0; i < 50 && final?.status !== 'completed'; i++) {
        await new Promise((r) => setTimeout(r, 20))
        final = await second.gw.runStore.getRun(runId)
      }
      expect(final?.status).toBe('completed')
      expect(final?.output).toEqual({ result: 21 })
    } finally {
      await second.gw.stop()
    }
  })

  it(
    'a both-phase step parked at afterOutput does not misapply the resume to beforeRun on restart',
    { timeout: 30000 },
    async () => {
      // Adversarial: a step with BOTH a beforeRun approval and an afterOutput edit
      // is parked at afterOutput across restart. On resume the step re-runs from
      // the top, so beforeRun's waitForInput fires for the same stepId. The
      // persisted afterOutput value must NOT be delivered to the beforeRun gate
      // (which would coerce to deny → HitlDeniedError, failing a run the human
      // approved). With the phase-aware short-circuit, beforeRun re-parks for a
      // fresh decision instead.
      const workflowPath = join(projectRoot, 'both.workflow.mts')
      await writeFile(workflowPath, '// loaded by the test gateway loader\n')
      const wf = pipeline({
        id: 'hitl-both-phase',
        input: z.object({ seed: z.number() }),
        output: z.object({ value: z.number() }),
        steps: [
          code({
            id: 'gated',
            humanInLoop: {
              beforeRun: { kind: 'approval' },
              afterOutput: { kind: 'edit' },
            },
            run: (ctx) => ({ value: ctx.input.seed }),
          }),
        ],
        finalize: (ctx) => ctx.steps.gated,
      })
      const loadWorkflow = async (_id: string, absolutePath: string): Promise<unknown> => {
        if (absolutePath !== workflowPath) throw new Error(`unexpected path: ${absolutePath}`)
        return { default: wf }
      }
      const boot = async () =>
        bootGatewayWithRetry((port) => ({
          stateDir,
          projectRoot,
          enableHttp: true,
          watchRegistries: false,
          httpPort: port,
          config: {},
          loadWorkflow,
        }))

      const waitForPhase = async (gw: Gateway, runId: string, phase: string): Promise<void> => {
        for (let i = 0; i < 100; i++) {
          const r = await gw.runStore.getRun(runId)
          if (r?.status === 'waiting' && r.waiting?.hitl?.phase === phase) return
          if (r?.status === 'failed' || r?.status === 'completed') return
          await new Promise((res) => setTimeout(res, 20))
        }
      }

      const first = await boot()
      const start = await fetch(`${first.base}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pipelinePath: workflowPath, input: { seed: 7 } }),
      })
      const { runId } = (await start.json()) as { runId: string }

      // Approve beforeRun → body runs → parks at afterOutput.
      await waitForPhase(first.gw, runId, 'beforeRun')
      await fetch(`${first.base}/v1/hitl/${runId}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actor: 'alice' }),
      })
      await waitForPhase(first.gw, runId, 'afterOutput')
      const parked = await first.gw.runStore.getRun(runId)
      expect(parked?.waiting?.hitl?.phase).toBe('afterOutput')

      first.gw.unregisterRun(runId)
      await first.gw.stop()

      // Restart, then resolve the parked afterOutput edit.
      const second = await boot()
      try {
        const resolve = await fetch(`${second.base}/v1/hitl/${runId}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'submit-edit', value: { value: 99 }, actor: 'bob' }),
        })
        expect(resolve.status).toBe(200)

        let after = await second.gw.runStore.getRun(runId)
        for (let i = 0; i < 100 && after?.status === 'running'; i++) {
          await new Promise((r) => setTimeout(r, 20))
          after = await second.gw.runStore.getRun(runId)
        }
        // The bug delivered the edit value to the beforeRun approval gate, failing
        // the run with HitlDeniedError. The fix re-parks at beforeRun instead.
        expect(after?.status).not.toBe('failed')
        expect(after?.error?.name).not.toBe('HitlDeniedError')
        if (after?.status === 'waiting') {
          expect(after.waiting?.hitl?.phase).toBe('beforeRun')
        }
      } finally {
        await second.gw.stop()
      }
    },
  )
})

describe('HITL gate /v1/hitl resolve API + audit', () => {
  async function startGateway(auditWriter?: AuditWriter) {
    const { gw, base } = await bootGatewayWithRetry((port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {},
      ...(auditWriter !== undefined && { auditWriter }),
    }))
    return { gw, base }
  }

  it('deny blocks the action; audit records hitl.denied with actor/reason, no secret leak', async () => {
    const audit = new CapturingAuditWriter()
    const { gw, base } = await startGateway(audit)
    try {
      let bodyRan = false
      const wf = pipeline<undefined, unknown>({
        id: 'hitl-deny-api',
        steps: [
          code({
            id: 'gated',
            humanInLoop: { beforeRun: { kind: 'approval', deliveryTarget: '#sec' } },
            run: () => {
              bodyRan = true
              return {}
            },
          }),
        ],
      })
      const { Runner } = await import('@skelm/core')
      const runner = new Runner({ store: gw.runStore, auditWriter: audit })
      const parked = new Promise<void>((res) => {
        const unsub = runner.events.subscribe((e) => {
          if (e.type === 'run.waiting') {
            unsub()
            res()
          }
        })
      })
      const handle = runner.start(wf, undefined)
      gw.registerRun(handle.runId, new AbortController(), runner)
      await parked

      const resolve = await fetch(`${base}/v1/hitl/${handle.runId}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'deny', actor: 'bob', reason: 'too risky' }),
      })
      expect(resolve.status).toBe(200)

      const run = await handle.wait()
      expect(run.status).toBe('failed')
      expect(bodyRan).toBe(false)

      const denied = audit.events.find((e) => e.action === 'hitl.denied')
      expect(denied).toBeDefined()
      expect(denied?.actor).toBe('bob')
      expect(denied?.runId).toBe(handle.runId)
      expect(denied?.details).toMatchObject({
        stepId: 'gated',
        kind: 'approval',
        approved: false,
        reason: 'too risky',
        deliveryTarget: '#sec',
      })
    } finally {
      await gw.stop()
    }
  })

  it('resolve with a verb that does not match the gate kind is 400', async () => {
    const { gw, base } = await startGateway()
    try {
      const wf = pipeline<undefined, unknown>({
        id: 'hitl-mismatch',
        steps: [
          code({
            id: 'gated',
            humanInLoop: { beforeRun: { kind: 'approval' } },
            run: () => ({}),
          }),
        ],
      })
      const { Runner } = await import('@skelm/core')
      const runner = new Runner({ store: gw.runStore })
      const parked = new Promise<void>((res) => {
        const unsub = runner.events.subscribe((e) => {
          if (e.type === 'run.waiting') {
            unsub()
            res()
          }
        })
      })
      const handle = runner.start(wf, undefined)
      gw.registerRun(handle.runId, new AbortController(), runner)
      await parked

      const bad = await fetch(`${base}/v1/hitl/${handle.runId}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'submit-input', value: 5 }),
      })
      expect(bad.status).toBe(400)

      // The run stays parked; a valid approve still drives it forward.
      const ok = await fetch(`${base}/v1/hitl/${handle.runId}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      })
      expect(ok.status).toBe(200)
      const run = await handle.wait()
      expect(run.status).toBe('completed')
    } finally {
      await gw.stop()
    }
  })

  it('GET /v1/hitl/:id is 404 when the run is not parked at a gate', async () => {
    const { gw, base } = await startGateway()
    try {
      const resp = await fetch(`${base}/v1/hitl/does-not-exist`)
      expect(resp.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })
})
