import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, type SuspendApprovalGate } from '../src/index.js'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-http-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

describe('Gateway HTTP control surface', () => {
  it('exposes /health, /gateway/pause|resume, /approvals, /sessions, /triggers', async () => {
    const port = await pickFreePort()
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
    })
    await gw.start()

    try {
      const base = `http://127.0.0.1:${port}`

      const health = await fetch(`${base}/health`).then((r) => r.json())
      expect(health.status).toBe('ok')
      expect(health.state).toBe('running')

      const pause = await fetch(`${base}/gateway/pause`, { method: 'POST' }).then((r) => r.json())
      expect(pause.state).toBe('paused')
      const resume = await fetch(`${base}/gateway/resume`, { method: 'POST' }).then((r) => r.json())
      expect(resume.state).toBe('running')

      const approvals = await fetch(`${base}/approvals`).then((r) => r.json())
      expect(approvals).toEqual([])

      const sessions = await fetch(`${base}/sessions`).then((r) => r.json())
      expect(sessions).toEqual([])

      const triggers = await fetch(`${base}/triggers`).then((r) => r.json())
      expect(triggers).toEqual([])

      // Approve a manually-staged pending approval and verify the gate resolves.
      const gate = gw.enforcement.approvalGate as SuspendApprovalGate
      const decision = gate.request({
        runId: 'run-x',
        stepId: 'step-y',
        action: 'agent.start',
        context: {},
      })
      // Allow persist() to flush before reading the snapshot.
      await new Promise((r) => setTimeout(r, 20))
      const queue = await fetch(`${base}/approvals`).then((r) => r.json())
      expect(queue).toHaveLength(1)
      expect(queue[0].id).toBe('run-x:step-y')

      const approveRes = await fetch(`${base}/runs/run-x/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stepId: 'step-y', approver: 'cli', reason: 'ok' }),
      }).then((r) => r.json())
      expect(approveRes).toEqual({ delivered: true })

      const resolved = await decision
      expect(resolved.approved).toBe(true)
      expect(resolved.approver).toBe('cli')
    } finally {
      await gw.stop()
    }
  })

  it('persists the approval queue snapshot to <stateDir>/approvals.json', async () => {
    const port = await pickFreePort()
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
    })
    await gw.start()
    try {
      const gate = gw.enforcement.approvalGate as SuspendApprovalGate
      const p = gate.request({ runId: 'r', stepId: 's', action: 'agent.start', context: {} })
      await new Promise((r) => setTimeout(r, 20))
      const raw = await fs.readFile(join(stateDir, 'approvals.json'), 'utf8')
      const snap = JSON.parse(raw)
      expect(snap).toHaveLength(1)
      expect(snap[0]).toMatchObject({ id: 'r:s', runId: 'r', stepId: 's' })
      gate.deny('r:s', 'cli', 'no')
      await p.catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      const after = JSON.parse(await fs.readFile(join(stateDir, 'approvals.json'), 'utf8'))
      expect(after).toEqual([])
    } finally {
      await gw.stop()
    }
  })
})

describe('Gateway runStore', () => {
  it('constructs a SqliteRunStore at <stateDir>/runs.sqlite by default', async () => {
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      config: {}, // no storage override → default to sqlite at stateDir
    })
    await gw.start()
    try {
      expect(gw.runStore).toBeDefined()
      // Constructing the store creates the file lazily; touch it via getRun.
      await gw.runStore.getRun('does-not-exist')
      const stat = await fs.stat(join(stateDir, 'runs.sqlite'))
      expect(stat.isFile()).toBe(true)
    } finally {
      await gw.stop()
    }
  })

  it('throws when accessed after stop()', async () => {
    const gw = new Gateway({ stateDir, watchRegistries: false })
    await gw.start()
    await gw.stop()
    expect(() => gw.runStore).toThrow(/runStore is not available/)
  })
})

async function pickFreePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error('port pick failed'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}
