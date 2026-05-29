/**
 * Plan §4.3: durable wait/resume across gateway restart.
 *
 * Phase 1 of the durability promise (proven here): a run that paused at
 * wait() before a gateway crash MUST be visible after restart with its
 * `waiting` snapshot intact in the SQLite RunStore. Operators can then
 * query / resume it.
 *
 * Phase 2 of the promise — actually delivering /resume input to a wait()
 * step whose runner died and was replaced by a fresh gateway process —
 * is a separate concern (the runner's wait callback is held in memory,
 * not durably anchored). The follow-up task is to either replay the run
 * up to the wait point on resume, or persist enough state to dispatch
 * the resume into a fresh runner. This test asserts only the durability
 * half; the resume-after-rehydrate test is gated behind that work.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline, wait } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/index.js'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-wait-restart-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
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

  // Follow-up: prove POST /runs/:runId/resume on a re-hydrated gateway
  // actually drives the parked run to completion. Requires the gateway to
  // re-instantiate the runner from the persisted Run record (or to replay
  // the workflow up to the wait point on demand). Not yet implemented;
  // the durability assertion above is the precondition for that work.
  it.skip('TODO: POST /runs/:id/resume after restart drives the run to completion', () => {})
})
