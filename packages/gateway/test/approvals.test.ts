import { describe, expect, it } from 'vitest'
import { SuspendApprovalGate } from '../src/index.js'

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
})
