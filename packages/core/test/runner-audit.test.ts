import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import type { AuditEvent, AuditWriter } from '../src/enforcement/audit-writer.js'
import { EnvSecretResolver } from '../src/enforcement/secret-resolver.js'
import { EventBus } from '../src/events.js'
import type { ExecFn } from '../src/index.js'
import { Runner, runPipeline } from '../src/runner.js'

class CapturingAuditWriter implements AuditWriter {
  readonly entries: AuditEvent[] = []
  async write(entry: AuditEvent): Promise<void> {
    this.entries.push(entry)
  }
}

describe('Runner — permission.denied → audit producer', () => {
  it('writes an audit row for every permission.denied event emitted during a run', async () => {
    const writer = new CapturingAuditWriter()
    const wf = pipeline({
      id: 'audit-deny',
      steps: [
        code({
          id: 's1',
          permissions: { allowedExecutables: [] },
          run: async (ctx) => (ctx.exec as ExecFn)({ command: 'node', args: ['-e', ''] }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { auditWriter: writer, runId: 'r1' })

    expect(run.status).toBe('failed')
    expect(writer.entries).toHaveLength(1)
    const row = writer.entries[0]
    expect(row?.runId).toBe('r1')
    expect(row?.actor).toBe('runtime')
    expect(row?.action).toBe('permission.denied')
    expect(row?.details).toMatchObject({
      stepId: 's1',
      dimension: 'executable',
    })
  })

  it('does not accumulate duplicate audit listeners on a shared event bus', async () => {
    const writer = new CapturingAuditWriter()
    const bus = new EventBus()
    const wf = pipeline({
      id: 'audit-deny-shared-bus',
      steps: [
        code({
          id: 's1',
          permissions: { allowedExecutables: [] },
          run: async (ctx) => (ctx.exec as ExecFn)({ command: 'node', args: ['-e', ''] }),
        }),
      ],
    })

    for (const runId of ['r1', 'r2']) {
      const runner = new Runner({ auditWriter: writer, events: bus })
      const run = await runner.start(wf, undefined, { runId }).wait()
      expect(run.status).toBe('failed')
    }

    expect(writer.entries.filter((entry) => entry.runId === 'r1')).toHaveLength(1)
    expect(writer.entries.filter((entry) => entry.runId === 'r2')).toHaveLength(1)
    expect(bus.listenerCount).toBe(0)
  })
})

describe('Runner — secret.not_found → audit producer', () => {
  it('writes an audit row when a secret resolves to undefined', async () => {
    const writer = new CapturingAuditWriter()
    const wf = pipeline({
      id: 'audit-secret-missing',
      steps: [
        code({
          id: 's2',
          secrets: ['OPENAI_KEY'],
          run: (ctx) => ctx.secrets?.get('OPENAI_KEY'),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, {
      auditWriter: writer,
      runId: 'r2',
      secretResolver: new EnvSecretResolver(() => ({})),
    })

    expect(run.status).toBe('failed')
    expect(writer.entries).toHaveLength(1)
    const row = writer.entries[0]
    expect(row?.runId).toBe('r2')
    expect(row?.actor).toBe('runtime')
    expect(row?.action).toBe('secret.not_found')
    expect(row?.details).toMatchObject({ stepId: 's2', name: 'OPENAI_KEY' })
  })

  it('does not include the secret value in the audit row', async () => {
    const writer = new CapturingAuditWriter()
    const wf = pipeline({
      id: 'audit-secret-value',
      steps: [
        code({
          id: 's3',
          secrets: ['DB_PASSWORD'],
          run: (ctx) => ctx.secrets?.get('DB_PASSWORD'),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, {
      auditWriter: writer,
      runId: 'r3',
      secretResolver: new EnvSecretResolver(() => ({})),
    })

    expect(run.status).toBe('failed')
    const row = writer.entries[0]
    // details must carry only the name (the fact), never a value
    const details = row?.details as Record<string, unknown>
    expect(Object.keys(details)).not.toContain('value')
  })
})

describe('Runner — audit subscription cleanup', () => {
  it('does not audit events published after a run finalizes', async () => {
    const writer = new CapturingAuditWriter()
    const bus = new EventBus()
    const wf = pipeline({
      id: 'audit-cleanup',
      steps: [code({ id: 'ok', run: () => ({ ok: true }) })],
    })
    await runPipeline(wf, undefined, {
      auditWriter: writer,
      events: bus,
      runId: 'r4',
    })
    bus.publish({
      type: 'backend.failover',
      runId: 'r4',
      stepId: 's4',
      kind: 'agent',
      from: 'codex',
      to: 'opencode',
      error: 'codex backend is not available',
      at: 1700000000003,
    })

    expect(writer.entries.some((entry) => entry.action === 'backend.failover')).toBe(false)
    expect(bus.listenerCount).toBe(0)
  })
})
