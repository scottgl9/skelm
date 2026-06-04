import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { code, pipeline, wait } from '@skelm/core'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { bootGatewayWithRetry } from './utils/boot-gateway.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function startGateway() {
  const stateDir = await mkdtemp(join(tmpdir(), 'skelm-wait-test-'))
  const { gw, base } = await bootGatewayWithRetry((port) => ({
    stateDir,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    config: {},
  }))
  return { gw, stateDir, base }
}

// ---------------------------------------------------------------------------
// wait() step — gateway integration tests
// ---------------------------------------------------------------------------

describe('wait() step — gateway HTTP integration', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn().catch(() => {})
  })

  it('run pauses at wait(), resumes via POST /runs/:runId/resume, completes', async () => {
    const { gw, stateDir, base } = await startGateway()
    cleanups.push(async () => {
      await gw.stop()
      await rm(stateDir, { recursive: true, force: true })
    })

    const wf = pipeline<{ x: number }, { result: number }>({
      id: 'wait-test',
      steps: [
        code({ id: 'prep', run: (ctx) => ({ prepped: (ctx.input as Record<string, unknown>).x }) }),
        wait({ id: 'gate', output: z.object({ approved: z.boolean() }) }),
        code({
          id: 'finish',
          run: (ctx) => ({
            result:
              ((ctx.steps.prep as Record<string, unknown>).prepped as number) +
              ((ctx.steps.gate as Record<string, unknown>).approved ? 10 : 0),
          }),
        }),
      ],
    })

    // Start the run via HTTP /pipelines/:id/run (sync fires then waits)
    // Instead, start it inline via Runner and poll for 'waiting' state
    const { Runner } = await import('@skelm/core')
    const runner = new Runner({ store: gw.runStore })
    const handle = runner.start(wf, { x: 5 })
    gw.registerRun(handle.runId, new AbortController(), runner)
    cleanups.push(async () => gw.unregisterRun(handle.runId))

    // Wait for the run to pause
    await new Promise<void>((res) => {
      const unsub = runner.events.subscribe((e) => {
        if (e.type === 'run.waiting') {
          unsub()
          res()
        }
      })
    })

    // POST /runs/:runId/resume with approved: true
    const resumeResp = (await fetch(`${base}/runs/${handle.runId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: { approved: true } }),
    }).then((r) => r.json())) as { resumed: boolean }
    expect(resumeResp.resumed).toBe(true)

    // Await completion (race-safe — resume already happened)
    const result = await handle.wait()
    expect(result.status).toBe('completed')
    expect((result.output as Record<string, unknown>)?.result).toBe(15) // 5 + 10

    // GET /runs/:runId — now completed
    // (gateway stores run via runStore — check it persisted)
    const stored = await gw.runStore.getRun(handle.runId)
    expect(stored?.status).toBe('completed')
  })

  it('rejects a schema-invalid resume with 400 and keeps the run suspended', async () => {
    const { gw, stateDir, base } = await startGateway()
    cleanups.push(async () => {
      await gw.stop()
      await rm(stateDir, { recursive: true, force: true })
    })

    const wf = pipeline<{ x: number }, { result: number }>({
      id: 'wait-validate-test',
      steps: [
        // A leading step so run.waiting publishes AFTER the first await — a
        // post-start subscribe (below) would miss it if wait() were first.
        code({ id: 'prep', run: () => ({ ok: true }) }),
        wait({ id: 'gate', output: z.object({ approved: z.boolean() }) }),
        code({
          id: 'finish',
          run: (ctx) => ({ result: (ctx.steps.gate as { approved: boolean }).approved ? 10 : 0 }),
        }),
      ],
    })

    const { Runner } = await import('@skelm/core')
    const runner = new Runner({ store: gw.runStore })
    const handle = runner.start(wf, { x: 0 })
    gw.registerRun(handle.runId, new AbortController(), runner)
    cleanups.push(async () => gw.unregisterRun(handle.runId))

    await new Promise<void>((res) => {
      const unsub = runner.events.subscribe((e) => {
        if (e.type === 'run.waiting') {
          unsub()
          res()
        }
      })
    })

    // Schema-INVALID resume: the wait step declared `approved: boolean`.
    // The resume must be rejected synchronously (400), NOT accepted (200) and
    // then fail the run asynchronously.
    const badResp = await fetch(`${base}/runs/${handle.runId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: { approved: 'yes-please' } }),
    })
    expect(badResp.status).toBe(400)

    // The run stays SUSPENDED after the rejected resume — a subsequent valid
    // resume still drives it to completion.
    const stored = await gw.runStore.getRun(handle.runId)
    expect(stored?.status).toBe('waiting')

    const goodResp = (await fetch(`${base}/runs/${handle.runId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: { approved: true } }),
    }).then((r) => r.json())) as { resumed: boolean }
    expect(goodResp.resumed).toBe(true)

    const result = await handle.wait()
    expect(result.status).toBe('completed')
    expect((result.output as Record<string, unknown>)?.result).toBe(10)
  })

  it('preserves explicit null resume output', async () => {
    const { gw, stateDir, base } = await startGateway()
    cleanups.push(async () => {
      await gw.stop()
      await rm(stateDir, { recursive: true, force: true })
    })

    const wf = pipeline<undefined, { resumedWith: null }>({
      id: 'wait-null-resume',
      steps: [
        wait({ id: 'gate', output: z.null() }),
        code({
          id: 'finish',
          run: (ctx) => ({ resumedWith: ctx.steps.gate }),
        }),
      ],
    })

    const { Runner } = await import('@skelm/core')
    const runner = new Runner({ store: gw.runStore })
    const waiting = new Promise<void>((res) => {
      const unsub = runner.events.subscribe((e) => {
        if (e.type === 'run.waiting') {
          unsub()
          res()
        }
      })
    })
    const handle = runner.start(wf, undefined)
    gw.registerRun(handle.runId, new AbortController(), runner)
    cleanups.push(async () => gw.unregisterRun(handle.runId))

    await waiting

    const resumeResp = await fetch(`${base}/runs/${handle.runId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: null }),
    })
    expect(resumeResp.status).toBe(200)

    const result = await handle.wait()
    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ resumedWith: null })
  })

  it('Run.waiting snapshot is populated while parked and cleared on resume', async () => {
    const { gw, stateDir } = await startGateway()
    cleanups.push(async () => {
      await gw.stop()
      await rm(stateDir, { recursive: true, force: true })
    })

    const wf = pipeline<undefined, unknown>({
      id: 'wait-snapshot',
      steps: [wait({ id: 'gate', message: 'please approve' })],
    })

    const { Runner } = await import('@skelm/core')
    const runner = new Runner({ store: gw.runStore })
    // Subscribe BEFORE start: when wait() is the first step, run.waiting
    // is published in the synchronous prefix of runPipeline before the
    // first await, so a post-start subscribe misses it.
    const waitingFired = new Promise<void>((res) => {
      const unsub = runner.events.subscribe((e) => {
        if (e.type === 'run.waiting') {
          unsub()
          res()
        }
      })
    })
    const handle = runner.start(wf, undefined)
    gw.registerRun(handle.runId, new AbortController(), runner)
    cleanups.push(async () => gw.unregisterRun(handle.runId))

    await waitingFired
    // Allow the run.waiting subscriber's storeWrites entry to flush.
    await new Promise((r) => setTimeout(r, 25))

    const parked = await gw.runStore.getRun(handle.runId)
    expect(parked?.waiting).toBeDefined()
    expect(parked?.waiting?.stepId).toBe('gate')
    expect(parked?.waiting?.message).toBe('please approve')
    expect(typeof parked?.waiting?.since).toBe('number')

    await runner.resume(handle.runId, {})
    await handle.wait()

    const final = await gw.runStore.getRun(handle.runId)
    expect(final?.status).toBe('completed')
    expect(final?.waiting).toBeUndefined()
  })

  it('wait() times out when no resume arrives', async () => {
    const { gw, stateDir } = await startGateway()
    cleanups.push(async () => {
      await gw.stop()
      await rm(stateDir, { recursive: true, force: true })
    })

    const wf = pipeline<undefined, never>({
      id: 'wait-timeout',
      steps: [wait({ id: 'gate', timeoutMs: 50 })],
    })

    const { Runner } = await import('@skelm/core')
    const runner = new Runner()
    const result = await runner.start(wf, undefined).wait()
    expect(result.status).toBe('failed')
    expect(result.error?.message).toMatch(/timed out|timeout/i)
  })
})
