/**
 * Adversarial coverage for plan §1.2: when a step's resolved policy
 * explicitly grants an agentmemory op but the chosen backend does NOT
 * declare `capabilities.agentmemory`, the runner must fail at step start
 * with a typed BackendCapabilityError instead of silently no-oping the
 * memory hooks (the prior failure mode that masked backends which
 * forgot to wire the integration).
 *
 * The `unrestricted` bypass remains a deliberate "trust the run" lever;
 * it must NOT trip this gate.
 */
import { describe, expect, it } from 'vitest'
import {
  type BackendCapabilities,
  BackendCapabilityError,
  BackendRegistry,
  type SkelmBackend,
} from '../../src/backend.js'
import { agent, pipeline } from '../../src/builders.js'
import { runPipeline } from '../../src/runner.js'

function fixtureAgentBackend(capabilities: Partial<BackendCapabilities> = {}): SkelmBackend {
  return {
    id: 'fixture',
    capabilities: {
      prompt: false,
      streaming: false,
      sessionLifecycle: false,
      mcp: false,
      skills: false,
      modelSelection: false,
      toolPermissions: 'native',
      ...capabilities,
    },
    async run() {
      return { text: 'ok' }
    },
  }
}

describe('agentmemory capability gate (plan §1.2)', () => {
  it('fails the step at start when policy grants an agentmemory op but backend omits the capability', async () => {
    const backend = fixtureAgentBackend()
    const registry = new BackendRegistry()
    registry.register(backend)
    const workflow = pipeline({
      id: 'amgate-explicit',
      steps: [
        agent({
          id: 'work',
          backend: backend.id,
          prompt: 'memory-grant step',
          permissions: { agentmemory: { allowObserve: true } },
        }),
      ],
    })
    const run = await runPipeline(workflow, undefined, { backends: registry })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe(BackendCapabilityError.name)
  })

  it('passes when the backend declares capabilities.agentmemory', async () => {
    const backend = fixtureAgentBackend({ agentmemory: true })
    const registry = new BackendRegistry()
    registry.register(backend)
    const workflow = pipeline({
      id: 'amgate-passthrough',
      steps: [
        agent({
          id: 'work',
          backend: backend.id,
          prompt: 'memory-grant step',
          permissions: { agentmemory: { allowObserve: true } },
        }),
      ],
    })
    const run = await runPipeline(workflow, undefined, { backends: registry })
    expect(run.status).toBe('completed')
  })

  it('does NOT trip when an unrestricted bypass is granted (capability check is structural, not permission-shaped)', async () => {
    const backend = fixtureAgentBackend()
    const registry = new BackendRegistry()
    registry.register(backend)
    const workflow = pipeline({
      id: 'amgate-bypass',
      steps: [
        agent({
          id: 'work',
          backend: backend.id,
          prompt: 'bypass step',
          permissions: { requestUnrestricted: true },
        }),
      ],
    })
    const run = await runPipeline(workflow, undefined, {
      backends: registry,
      unrestrictedGrant: true,
    })
    expect(run.status).toBe('completed')
  })
})
