/**
 * Plan §1.4: when an unrestricted bypass fires, the audit log must
 * enumerate which dimensions were lifted so post-hoc forensics can
 * distinguish step-author escalation from runtime-emitted denials.
 *
 * Pre-change: one `permission.bypassed` row per step, actor 'runtime'.
 * Post-change: one summary row PLUS one `permission.bypass.<dim>` row
 * per dimension, all flagged `actor: 'step-author'` to mark the
 * escalation as author-requested.
 */
import { describe, expect, it } from 'vitest'
import { agent, pipeline } from '../../src/builders.js'
import {
  ALL_PERMISSION_DIMENSIONS,
  type AuditEvent,
  type AuditWriter,
  BackendRegistry,
  type SkelmBackend,
} from '../../src/index.js'
import { runPipeline } from '../../src/runner.js'

class RecordingAuditWriter implements AuditWriter {
  readonly entries: AuditEvent[] = []
  async write(entry: AuditEvent): Promise<void> {
    this.entries.push(entry)
  }
}

function passthroughBackend(): SkelmBackend {
  return {
    id: 'echo',
    capabilities: {
      prompt: false,
      streaming: false,
      sessionLifecycle: false,
      mcp: false,
      skills: false,
      modelSelection: false,
      toolPermissions: 'native',
      agentmemory: true,
    },
    async run() {
      return { text: 'ok' }
    },
  }
}

describe('permission.bypass per-dimension audit (plan §1.4)', () => {
  it('emits one summary row + one row per permission dimension under unrestricted bypass', async () => {
    const auditWriter = new RecordingAuditWriter()
    const registry = new BackendRegistry()
    registry.register(passthroughBackend())
    const workflow = pipeline({
      id: 'bypass-audit',
      steps: [
        agent({
          id: 'work',
          backend: 'echo',
          prompt: 'bypass me',
          permissions: { requestUnrestricted: true },
        }),
      ],
    })
    await runPipeline(workflow, undefined, {
      backends: registry,
      unrestrictedGrant: true,
      auditWriter,
    })

    const summary = auditWriter.entries.find((e) => e.action === 'permission.bypassed')
    expect(summary).toBeDefined()
    expect(summary?.actor).toBe('step-author')
    expect((summary?.details as { dimensions?: readonly string[] }).dimensions).toEqual([
      ...ALL_PERMISSION_DIMENSIONS,
    ])

    for (const dimension of ALL_PERMISSION_DIMENSIONS) {
      const row = auditWriter.entries.find((e) => e.action === `permission.bypass.${dimension}`)
      expect(row, `missing bypass row for dimension '${dimension}'`).toBeDefined()
      expect(row?.actor).toBe('step-author')
      expect((row?.details as { dimension?: string }).dimension).toBe(dimension)
    }
  })

  it('does NOT emit per-dimension rows when no bypass is active', async () => {
    const auditWriter = new RecordingAuditWriter()
    const registry = new BackendRegistry()
    registry.register(passthroughBackend())
    const workflow = pipeline({
      id: 'no-bypass',
      steps: [agent({ id: 'work', backend: 'echo', prompt: 'normal' })],
    })
    await runPipeline(workflow, undefined, { backends: registry, auditWriter })
    expect(auditWriter.entries.some((e) => e.action.startsWith('permission.bypass'))).toBe(false)
  })
})
