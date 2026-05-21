import {
  type AuditEvent,
  type AuditWriter,
  BackendRegistry,
  EventBus,
  type RunEvent,
  type SkelmBackend,
  agent,
  pipeline,
  runPipeline,
} from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { SuspendApprovalGate } from '../../src/index.js'

// End-to-end proof that the `approval` permission dimension actually
// denies execution when the wired ApprovalGate rejects. Without this,
// approval was the one declared dimension with no adversarial fixture.

class CapturingAuditWriter implements AuditWriter {
  events: AuditEvent[] = []
  async write(e: AuditEvent): Promise<void> {
    this.events.push(e)
  }
}

function noopBackend(): SkelmBackend {
  return {
    id: 'noop-agent',
    capabilities: {
      prompt: true,
      streaming: false,
      sessionLifecycle: false,
      mcp: false,
      skills: false,
      modelSelection: false,
      toolPermissions: 'wrapped',
    },
    async run() {
      return { text: 'should not run' }
    },
  }
}

describe('approval permission — adversarial e2e', () => {
  it('SuspendApprovalGate denial fails the run with ApprovalDeniedError', async () => {
    const registry = new BackendRegistry()
    registry.register(noopBackend())

    const audit = new CapturingAuditWriter()
    const gate = new SuspendApprovalGate({ auditWriter: audit })

    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((e) => seen.push(e))

    // Auto-deny every incoming approval as soon as it lands.
    const originalRequest = gate.request.bind(gate)
    gate.request = async (req) => {
      queueMicrotask(() => {
        gate.deny(`${req.runId}:${req.stepId}`, 'security-bot', 'policy-block')
      })
      return originalRequest(req)
    }

    const wf = pipeline({
      id: 'approval-denial',
      steps: [
        agent({
          id: 'guarded',
          backend: 'noop-agent',
          prompt: 'go',
          permissions: {
            allowedTools: [],
            approval: { on: ['tool'] },
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, {
      backends: registry,
      events,
      approvalGate: gate,
    })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('ApprovalDeniedError')
    expect(run.error?.message).toMatch(/security-bot|policy-block/)

    const actions = audit.events.map((e) => e.action)
    expect(actions).toContain('approval.requested')
    expect(actions).toContain('approval.resolved')
    const resolved = audit.events.find((e) => e.action === 'approval.resolved')
    expect(resolved?.actor).toBe('security-bot')
    expect(resolved?.details).toMatchObject({ approved: false, reason: 'policy-block' })

    expect(seen.some((e) => e.type === 'step.error' && e.stepId === 'guarded')).toBe(true)
  })
})
