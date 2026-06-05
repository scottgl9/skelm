/**
 * Plan §4.3: durable wait/resume across gateway restart.
 *
 * A run that paused at
 * wait() before a gateway crash MUST be visible after restart with its
 * `waiting` snapshot intact in the SQLite RunStore, and POST /resume on the
 * restarted gateway must rehydrate the run and drive it to completion.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { code, pipeline, wait } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Gateway } from '../src/index.js'
import { bootGatewayWithRetry } from './utils/boot-gateway.js'

let stateDir: string
let projectRoot: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-wait-restart-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-wait-restart-project-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

describe('wait() durability across gateway restart (plan §4.3)', () => {
  it('a paused run survives gateway stop+restart with its waiting snapshot intact', async () => {
    // First gateway lifecycle: start, park a pipeline at wait(), stop.
    const gw1 = new Gateway({
      stateDir,
      enableHttp: false,
      watchRegistries: false,
      config: {},
    })
    await gw1.start()

    const wf = pipeline<undefined, unknown>({
      id: 'wait-restart-test',
      steps: [wait({ id: 'gate', message: 'pause across restart' })],
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
    // Allow the run.waiting subscriber's persistence to flush.
    await new Promise((r) => setTimeout(r, 50))

    const parkedBefore = await gw1.runStore.getRun(handle.runId)
    expect(parkedBefore?.status).toBe('waiting')
    expect(parkedBefore?.waiting?.stepId).toBe('gate')
    expect(parkedBefore?.waiting?.message).toBe('pause across restart')

    // Cut the gateway WITHOUT graceful resume — simulates a SIGKILL while a
    // run is parked at wait(). The in-memory runner / wait callback is lost.
    gw1.unregisterRun(handle.runId)
    await gw1.stop()

    // Second gateway lifecycle: start fresh against the same stateDir.
    // The SQLite RunStore at <stateDir>/runs.sqlite is reopened; recovery
    // runs against it. Per recoverInterruptedRuns(), only `running` runs
    // are finalized; `waiting` runs MUST be left intact so an operator
    // can resume them.
    const gw2 = new Gateway({
      stateDir,
      enableHttp: false,
      watchRegistries: false,
      config: {},
    })
    await gw2.start()
    try {
      const parkedAfter = await gw2.runStore.getRun(handle.runId)
      expect(parkedAfter, 'paused run must survive restart in the store').toBeDefined()
      expect(parkedAfter?.status).toBe('waiting')
      expect(parkedAfter?.waiting?.stepId).toBe('gate')
      expect(parkedAfter?.waiting?.message).toBe('pause across restart')
      expect(parkedAfter?.waiting?.since).toBe(parkedBefore?.waiting?.since)
    } finally {
      await gw2.stop()
    }
  })

  it('POST /runs/:id/resume after restart rehydrates and completes the run', async () => {
    const workflowPath = join(projectRoot, 'rehydrate.workflow.mts')
    await writeFile(workflowPath, '// loaded by the test gateway loader\n')
    const wf = pipeline({
      id: 'wait-rehydrate-test',
      input: z.object({ seed: z.number() }),
      output: z.object({ result: z.number() }),
      steps: [
        code({ id: 'prep', run: (ctx) => ({ doubled: ctx.input.seed * 2 }) }),
        wait({
          id: 'gate',
          message: 'pause across restart',
          output: z.object({ add: z.number() }),
        }),
        code({
          id: 'finish',
          run: (ctx) => ({ result: ctx.steps.prep.doubled + ctx.steps.gate.add }),
        }),
      ],
      finalize: (ctx) => ctx.steps.finish,
    })
    const loadWorkflow = async (_id: string, absolutePath: string): Promise<unknown> => {
      if (absolutePath !== workflowPath)
        throw new Error(`unexpected workflow path: ${absolutePath}`)
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
      body: JSON.stringify({ pipelinePath: workflowPath, input: { seed: 7 } }),
    })
    expect(start.status).toBe(200)
    const started = (await start.json()) as { runId: string }
    const runId = started.runId

    for (let i = 0; i < 50; i++) {
      const stored = await first.gw.runStore.getRun(runId)
      if (stored?.status === 'waiting') break
      await new Promise((r) => setTimeout(r, 20))
    }
    const parkedBefore = await first.gw.runStore.getRun(runId)
    expect(parkedBefore?.status).toBe('waiting')
    expect(parkedBefore?.steps.map((step) => step.id)).toEqual(['prep'])

    first.gw.unregisterRun(runId)
    await first.gw.stop()

    const second = await boot()
    try {
      const resume = await fetch(`${second.base}/runs/${runId}/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { add: 5 } }),
      })
      const resumeText = await resume.text()
      if (resume.status !== 200) throw new Error(`resume failed: ${resume.status} ${resumeText}`)
      expect(JSON.parse(resumeText)).toMatchObject({ resumed: true, rehydrated: true })

      let final = await second.gw.runStore.getRun(runId)
      for (let i = 0; i < 50 && final?.status !== 'completed'; i++) {
        await new Promise((r) => setTimeout(r, 20))
        final = await second.gw.runStore.getRun(runId)
      }
      expect(final?.status).toBe('completed')
      expect(final?.output).toEqual({ result: 19 })
      expect(final?.steps.map((step) => step.id)).toEqual(['prep', 'gate', 'finish'])
    } finally {
      await second.gw.stop()
    }
  })
})
