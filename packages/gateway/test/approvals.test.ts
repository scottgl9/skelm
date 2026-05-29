import type { AuditEvent, AuditWriter } from '@skelm/core'
import { describe, expect, it } from 'vitest'
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
    const first = gate.request({ runId: 'r3', stepId: 's3', action: 'x', context: {} })
    await expect(
      gate.request({ runId: 'r3', stepId: 's3', action: 'x', context: {} }),
    ).rejects.toThrow(/already pending/)
    gate.drain()
    await expect(first).rejects.toThrow()
  })

  it('drain() rejects all pending approvals', async () => {
    const gate = new SuspendApprovalGate()
    const p = gate.request({ runId: 'r4', stepId: 's4', action: 'x', context: {} })
    gate.drain('shutdown')
    await expect(p).rejects.toThrow(/cancelled: shutdown/)
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

  it('emits approval.cancelled on drain()', async () => {
    const audit = new CapturingAuditWriter()
    const gate = new SuspendApprovalGate({ auditWriter: audit })
    const p = gate.request({ runId: 'rD', stepId: 'sD', action: 'x', context: {} })
    await tick()
    gate.drain('shutdown')
    await expect(p).rejects.toThrow(/cancelled: shutdown/)
    await tick()
    const cancelled = audit.events.find((e) => e.action === 'approval.cancelled')
    expect(cancelled?.details).toMatchObject({ reason: 'shutdown' })
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
