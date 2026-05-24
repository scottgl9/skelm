import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { code, pipeline } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTriggerDispatcher } from '../src/index.js'
import { bootGatewayWithRetry } from './utils/boot-gateway.js'

let stateDir: string
let projectRoot: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-sse-state-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-sse-proj-'))
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await fs.writeFile(join(projectRoot, 'workflows/hello.workflow.mts'), 'export default {}')
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

/**
 * Consume SSE frames from a Response body until terminal-or-timeout. Returns
 * the parsed event list (in order received) plus the raw header line counts.
 */
async function consumeSse(
  res: Response,
  opts: { until: (events: Array<{ event: string; data: unknown }>) => boolean; timeoutMs?: number },
): Promise<Array<{ event: string; data: unknown }>> {
  if (res.body === null) throw new Error('no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const collected: Array<{ event: string; data: unknown }> = []
  let buf = ''
  const deadline = Date.now() + (opts.timeoutMs ?? 5000)
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx = buf.indexOf('\n\n')
      while (idx !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        let evt = 'message'
        let data = ''
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) evt = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        let parsed: unknown = data
        try {
          parsed = JSON.parse(data)
        } catch {
          // leave as string
        }
        collected.push({ event: evt, data: parsed })
        if (opts.until(collected)) return collected
        idx = buf.indexOf('\n\n')
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
  return collected
}

describe('/runs/:runId/stream SSE', () => {
  it('replays persisted events then tails live ones (no race on fast runs)', async () => {
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {
        registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
      },
    }))
    try {
      const wf = pipeline({
        id: 'hello',
        steps: [
          code({
            id: 'greet',
            run: () => ({ greeting: 'hi' }),
          }),
        ],
      })
      gw.managers.triggers.setOnFire(
        createTriggerDispatcher({
          gateway: gw,
          loadWorkflow: async () => ({ default: wf }),
        }),
      )
      gw.managers.triggers.register({
        kind: 'manual',
        id: 'wake',
        workflowId: 'workflows/hello.workflow.mts',
      })

      // Fire and wait for completion BEFORE subscribing. This is the race
      // the new replay-then-tail SSE handler closes: a sub-second run is
      // long-finished by the time the GET /stream lands, but the client
      // should still see every step event.
      const fire = await fetch(`${base}/triggers/wake/fire`, { method: 'POST' })
      expect(fire.ok).toBe(true)

      // Find the run id via the run listing.
      const runs = (await fetch(`${base}/runs`).then((r) => r.json())) as Array<{
        runId: string
        status: string
      }>
      expect(runs.length).toBe(1)
      const runId = runs[0]?.runId
      expect(runId).toBeDefined()
      expect(runs[0]?.status).toBe('completed')

      // Subscribe to the stream of an already-completed run. Expect to
      // receive the persisted event log in full plus the initial run.state
      // snapshot, then the stream closes on the terminal run.completed.
      const sse = await fetch(`${base}/runs/${runId}/stream`, {
        headers: { accept: 'text/event-stream' },
      })
      expect(sse.ok).toBe(true)
      expect(sse.headers.get('content-type')).toContain('text/event-stream')

      const events = await consumeSse(sse, {
        until: (evts) => evts.some((e) => e.event === 'run.completed'),
        timeoutMs: 3000,
      })

      const types = events.map((e) => e.event)
      expect(types[0]).toBe('run.state') // initial snapshot
      expect(types).toContain('run.created')
      expect(types).toContain('run.started')
      expect(types).toContain('step.start')
      expect(types).toContain('step.complete')
      expect(types).toContain('run.completed')

      // No duplicate event types beyond what the run actually produced.
      const completedCount = types.filter((t) => t === 'run.completed').length
      expect(completedCount).toBe(1)
    } finally {
      await gw.stop()
    }
  })
})
