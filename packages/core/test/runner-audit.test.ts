import { describe, expect, it } from 'vitest'
import type { AuditEvent, AuditWriter } from '../src/enforcement/audit-writer.js'
import { Runner } from '../src/runner.js'

class CapturingAuditWriter implements AuditWriter {
  readonly entries: AuditEvent[] = []
  async write(entry: AuditEvent): Promise<void> {
    this.entries.push(entry)
  }
}

describe('Runner — permission.denied → audit producer', () => {
  it('writes an audit row for every permission.denied event published on the bus', async () => {
    const writer = new CapturingAuditWriter()
    const runner = new Runner({ auditWriter: writer })
    runner.events.publish({
      type: 'permission.denied',
      runId: 'r1',
      stepId: 's1',
      dimension: 'executable',
      detail: 'tool "shell.exec" requested executable "bash"',
      at: 1700000000000,
    })
    // Audit write is async (chained off the subscription); flush.
    await new Promise((r) => setImmediate(r))

    expect(writer.entries).toHaveLength(1)
    const row = writer.entries[0]
    expect(row?.runId).toBe('r1')
    expect(row?.actor).toBe('runtime')
    expect(row?.action).toBe('permission.denied')
    expect(row?.details).toMatchObject({
      stepId: 's1',
      dimension: 'executable',
      detail: 'tool "shell.exec" requested executable "bash"',
      at: 1700000000000,
    })
  })

  it('does not write audit rows for non-denial events', async () => {
    const writer = new CapturingAuditWriter()
    const runner = new Runner({ auditWriter: writer })
    runner.events.publish({ type: 'run.started', runId: 'r1', at: 1 })
    runner.events.publish({
      type: 'step.complete',
      runId: 'r1',
      stepId: 's1',
      kind: 'code',
      output: {},
      durationMs: 1,
      at: 2,
    })
    await new Promise((r) => setImmediate(r))
    expect(writer.entries).toHaveLength(0)
  })
})

describe('Runner — secret.not_found → audit producer', () => {
  it('writes an audit row when a secret resolves to undefined', async () => {
    const writer = new CapturingAuditWriter()
    const runner = new Runner({ auditWriter: writer })
    runner.events.publish({
      type: 'secret.not_found',
      runId: 'r2',
      stepId: 's2',
      name: 'OPENAI_KEY',
      at: 1700000000001,
    })
    await new Promise((r) => setImmediate(r))

    expect(writer.entries).toHaveLength(1)
    const row = writer.entries[0]
    expect(row?.runId).toBe('r2')
    expect(row?.actor).toBe('runtime')
    expect(row?.action).toBe('secret.not_found')
    expect(row?.details).toMatchObject({ stepId: 's2', name: 'OPENAI_KEY' })
  })

  it('does not include the secret value in the audit row', async () => {
    const writer = new CapturingAuditWriter()
    const runner = new Runner({ auditWriter: writer })
    runner.events.publish({
      type: 'secret.not_found',
      runId: 'r3',
      stepId: 's3',
      name: 'DB_PASSWORD',
      at: 1700000000002,
    })
    await new Promise((r) => setImmediate(r))

    const row = writer.entries[0]
    // details must carry only the name (the fact), never a value
    const details = row?.details as Record<string, unknown>
    expect(Object.keys(details)).not.toContain('value')
  })
})

describe('Runner — backend.failover → audit producer', () => {
  it('writes an audit row when an agent backend fails over', async () => {
    const writer = new CapturingAuditWriter()
    const runner = new Runner({ auditWriter: writer })
    runner.events.publish({
      type: 'backend.failover',
      runId: 'r4',
      stepId: 's4',
      kind: 'agent',
      from: 'codex',
      to: 'opencode',
      error: 'codex backend is not available',
      at: 1700000000003,
    })
    await new Promise((r) => setImmediate(r))

    expect(writer.entries).toHaveLength(1)
    const row = writer.entries[0]
    expect(row?.runId).toBe('r4')
    expect(row?.actor).toBe('runtime')
    expect(row?.action).toBe('backend.failover')
    expect(row?.details).toMatchObject({
      stepId: 's4',
      kind: 'agent',
      from: 'codex',
      to: 'opencode',
      error: 'codex backend is not available',
      at: 1700000000003,
    })
  })
})
