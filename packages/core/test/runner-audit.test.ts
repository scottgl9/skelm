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
