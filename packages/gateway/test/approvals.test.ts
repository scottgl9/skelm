import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuditEvent, AuditWriter } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SuspendApprovalGate } from '../src/index.js'

class CapturingAuditWriter implements AuditWriter {
  events: AuditEvent[] = []
  async write(e: AuditEvent): Promise<void> {
    this.events.push(e)
  }
}

class SlowAuditWriter implements AuditWriter {
  events: AuditEvent[] = []
  pendingWrites = 0
  async write(e: AuditEvent): Promise<void> {
    this.pendingWrites++
    await new Promise((r) => setTimeout(r, 10))
    this.events.push(e)
    this.pendingWrites--
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

async function waitFor(assertion: () => void | Promise<void>, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  throw lastErr
}

describe('SuspendApprovalGate', () => {
  it('suspends until approve() delivers a decision', async () => {
    const gate = new SuspendApprovalGate()
    const promise = gate.request({
      runId: 'r1',
      stepId: 's1',
      action: 'tool.exec',
      context: { tool: 'rm' },
    })
    expect(gate.list().map((p) => p.id)).toEqual(['r1:s1'])
    expect(gate.approve('r1:s1', 'alice', 'looks fine')).toBe(true)
    const decision = await promise
    expect(decision.approved).toBe(true)
    expect(decision.approver).toBe('alice')
    expect(gate.list()).toEqual([])
  })

  it('deny resolves with approved=false', async () => {
    const gate = new SuspendApprovalGate()
    const p = gate.request({ runId: 'r2', stepId: 's2', action: 'fs.write', context: {} })
    expect(gate.deny('r2:s2', 'bob', 'too risky')).toBe(true)
    const d = await p
    expect(d.approved).toBe(false)
    expect(d.reason).toBe('too risky')
  })

  it('returns false when delivering to an unknown id', () => {
    const gate = new SuspendApprovalGate()
    expect(gate.approve('nope', 'a')).toBe(false)
    expect(gate.deny('nope', 'a')).toBe(false)
  })

  it('rejects duplicate request for the same run/step', async () => {
    const gate = new SuspendApprovalGate()
    void gate.request({ runId: 'r3', stepId: 's3', action: 'x', context: {} })
    await expect(
      gate.request({ runId: 'r3', stepId: 's3', action: 'x', context: {} }),
    ).rejects.toThrow(/already pending/)
    gate.approve('r3:s3')
  })

  it('drain() preserves pending approvals (does not reject)', async () => {
    const gate = new SuspendApprovalGate()
    const p = gate.request({ runId: 'r4', stepId: 's4', action: 'x', context: {} })
    let settled = false
    void p.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await gate.drain('shutdown')
    await tick()
    expect(settled).toBe(false)
    // The approval survives in the queue so it can be reloaded after restart.
    expect(gate.list().map((e) => e.id)).toEqual(['r4:s4'])
  })

  it('honors per-gate timeout', async () => {
    const gate = new SuspendApprovalGate({ timeoutMs: 10 })
    const p = gate.request({ runId: 'r5', stepId: 's5', action: 'x', context: {} })
    await expect(p).rejects.toThrow(/timed out/)
  })

  it('emits audit entries for request → resolve', async () => {
    const audit = new CapturingAuditWriter()
    const gate = new SuspendApprovalGate({ auditWriter: audit })
    const p = gate.request({
      runId: 'rA',
      stepId: 'sA',
      action: 'tool.exec',
      context: { tool: 'shell' },
    })
    await tick()
    gate.approve('rA:sA', 'alice', 'ok')
    await p
    await tick()
    expect(audit.events.map((e) => e.action)).toEqual(['approval.requested', 'approval.resolved'])
    const resolved = audit.events[1]
    expect(resolved?.actor).toBe('alice')
    expect(resolved?.details).toMatchObject({
      approvalId: 'rA:sA',
      stepId: 'sA',
      requestedAction: 'tool.exec',
      approved: true,
      reason: 'ok',
    })
  })

  it('emits approval.resolved with approved=false on deny', async () => {
    const audit = new CapturingAuditWriter()
    const gate = new SuspendApprovalGate({ auditWriter: audit })
    const p = gate.request({ runId: 'rB', stepId: 'sB', action: 'fs.write', context: {} })
    await tick()
    gate.deny('rB:sB', 'bob', 'risky')
    await expect(p).resolves.toMatchObject({ approved: false })
    await tick()
    const resolved = audit.events.find((e) => e.action === 'approval.resolved')
    expect(resolved?.actor).toBe('bob')
    expect(resolved?.details).toMatchObject({ approved: false, reason: 'risky' })
  })

  it('emits approval.expired on timeout', async () => {
    const audit = new CapturingAuditWriter()
    const gate = new SuspendApprovalGate({ timeoutMs: 5, auditWriter: audit })
    const p = gate.request({ runId: 'rC', stepId: 'sC', action: 'x', context: {} })
    await expect(p).rejects.toThrow(/timed out/)
    await tick()
    expect(audit.events.map((e) => e.action)).toEqual(['approval.requested', 'approval.expired'])
  })

  it('drain() does not reject pending approvals or emit a cancelled event', async () => {
    const audit = new CapturingAuditWriter()
    const gate = new SuspendApprovalGate({ auditWriter: audit })
    const p = gate.request({ runId: 'rD', stepId: 'sD', action: 'x', context: {} })
    let rejected = false
    void p.catch(() => {
      rejected = true
    })
    await tick()
    await gate.drain('shutdown')
    await tick()
    expect(rejected).toBe(false)
    expect(audit.events.some((e) => e.action === 'approval.cancelled')).toBe(false)
  })

  it('swallows audit writer failures without breaking the gate', async () => {
    const failing: AuditWriter = {
      async write() {
        throw new Error('disk full')
      },
    }
    const gate = new SuspendApprovalGate({ auditWriter: failing })
    const p = gate.request({ runId: 'rE', stepId: 'sE', action: 'x', context: {} })
    await tick()
    gate.approve('rE:sE', 'alice')
    await expect(p).resolves.toMatchObject({ approved: true })
  })

  // Plan §4.2: audit-then-resolve ordering on the resolution path.
  // The approval promise must NOT settle before the durable
  // 'approval.resolved' audit row has been flushed, so a crash between
  // resolve() and the audit write completing cannot leave forensics
  // with a 'requested' event and no matching 'resolved' event.
  it('awaits the audit write before resolving the approval promise', async () => {
    const slow = new SlowAuditWriter()
    const gate = new SuspendApprovalGate({ auditWriter: slow })
    const p = gate.request({ runId: 'r-slow', stepId: 's', action: 'a', context: {} })
    await tick()
    gate.approve('r-slow:s', 'alice')
    const decision = await p
    // By the time the promise settled, the audit writer must have
    // flushed the resolved event (no in-flight writes from the
    // resolution path).
    expect(decision.approved).toBe(true)
    expect(slow.events.some((e) => e.action === 'approval.resolved')).toBe(true)
  })
})

describe('SuspendApprovalGate durable reload', () => {
  let dir: string
  let persistPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skelm-approvals-'))
    persistPath = join(dir, 'approvals.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reloads a parked approval after a drain+restart and resolves on approve', async () => {
    const auditA = new CapturingAuditWriter()
    const gateA = new SuspendApprovalGate({ persistPath, auditWriter: auditA })
    void gateA.request({ runId: 'r1', stepId: 's1', action: 'tool.exec', context: { tool: 'rm' } })
    await tick()
    // Stop the "old" gateway: pending approval must survive, not be rejected.
    await gateA.drain('gateway stopping')

    const snap = JSON.parse(await fs.readFile(persistPath, 'utf8'))
    expect(snap).toHaveLength(1)

    // Fresh gate on the same state dir (a real restart) rehydrates the queue.
    const auditB = new CapturingAuditWriter()
    const gateB = new SuspendApprovalGate({ persistPath, auditWriter: auditB })
    await gateB.load()
    expect(gateB.list().map((e) => e.id)).toEqual(['r1:s1'])
    expect(gateB.list()[0]?.request.context).toEqual({ tool: 'rm' })

    // The reloaded approval is still resolvable; approve records the decision
    // and clears it from the durable snapshot.
    expect(gateB.approve('r1:s1', 'alice', 'ok')).toBe(true)
    await tick()
    expect(auditB.events.map((e) => e.action)).toContain('approval.resolved')
    expect(gateB.list()).toEqual([])
    await waitFor(async () => {
      const after = JSON.parse(await fs.readFile(persistPath, 'utf8'))
      expect(after).toEqual([])
    })
  })

  it('reloaded approval can be denied after restart', async () => {
    const gateA = new SuspendApprovalGate({ persistPath })
    void gateA.request({ runId: 'r2', stepId: 's2', action: 'fs.write', context: {} })
    await tick()
    await gateA.drain()

    const gateB = new SuspendApprovalGate({ persistPath })
    await gateB.load()
    expect(gateB.deny('r2:s2', 'bob', 'too risky')).toBe(true)
    await tick()
    expect(gateB.list()).toEqual([])
  })

  it('adopts resolvers when the same run re-requests a reloaded approval', async () => {
    const gateA = new SuspendApprovalGate({ persistPath })
    void gateA.request({ runId: 'r3', stepId: 's3', action: 'x', context: {} })
    await tick()
    await gateA.drain()

    const gateB = new SuspendApprovalGate({ persistPath })
    await gateB.load()
    // A resumed run re-issues request() for the same id; the live promise must
    // resolve when the reloaded entry is approved.
    const p = gateB.request({ runId: 'r3', stepId: 's3', action: 'x', context: {} })
    expect(gateB.approve('r3:s3', 'carol')).toBe(true)
    await expect(p).resolves.toMatchObject({ approved: true, approver: 'carol' })
  })
})
