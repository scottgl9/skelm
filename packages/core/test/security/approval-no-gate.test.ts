import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from '../../src/backend.js'
import { agent, pipeline } from '../../src/builders.js'
import { runPipeline } from '../../src/runner.js'

// Adversarial: a step that declares an approval policy MUST not run
// when no approvalGate is wired on the runtime. The previous behaviour
// silently skipped the gate ("if (policy?.approval && approvalGate)"),
// meaning a workflow asking for human approval got none and ran anyway
// — a default-deny regression.

const stubBackend: SkelmBackend = {
  id: 'stub',
  capabilities: {
    prompt: true,
    streaming: false,
    sessionLifecycle: false,
    mcp: false,
    skills: false,
    modelSelection: false,
    toolPermissions: 'native',
  },
  async run() {
    return { text: 'ok' }
  },
}
const backends = new BackendRegistry()
backends.register(stubBackend)

describe('approval — fail-closed without gate', () => {
  it('agent step with approval policy throws ApprovalDeniedError when no gate is wired', async () => {
    const wf = pipeline({
      id: 'fixture-approval-no-gate',
      steps: [
        agent({
          id: 'gated',
          backend: 'stub',
          prompt: 'go',
          permissions: { approval: { on: ['tool'] } },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('ApprovalDeniedError')
    expect(run.error?.message).toMatch(/approval/i)
  })

  it('agent step without an approval policy runs normally even with no gate wired', async () => {
    const wf = pipeline({
      id: 'fixture-no-approval',
      steps: [
        agent({
          id: 'ungated',
          backend: 'stub',
          prompt: 'go',
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends })
    expect(run.status).toBe('completed')
  })
})
