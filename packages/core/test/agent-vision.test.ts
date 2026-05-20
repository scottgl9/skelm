import { describe, expect, it } from 'vitest'
import {
  type AgentRequest,
  type AgentResponse,
  type BackendCapabilities,
  type BackendContext,
  BackendRegistry,
  type SkelmBackend,
} from '../src/backend.js'
import { agent, pipeline } from '../src/builders.js'
import { runPipeline } from '../src/runner.js'

function makeAgentBackend(opts: {
  id: string
  vision?: boolean
  respond?: (req: AgentRequest) => AgentResponse | Promise<AgentResponse>
}): SkelmBackend & { calls: AgentRequest[] } {
  const calls: AgentRequest[] = []
  const capabilities: BackendCapabilities = {
    prompt: false,
    streaming: false,
    sessionLifecycle: false,
    mcp: false,
    skills: false,
    modelSelection: false,
    toolPermissions: 'unsupported',
    ...(opts.vision !== undefined && { vision: opts.vision }),
  }
  return {
    id: opts.id,
    capabilities,
    calls,
    async run(req: AgentRequest, _ctx: BackendContext): Promise<AgentResponse> {
      calls.push(req)
      return opts.respond?.(req) ?? { text: 'ok' }
    },
  } as SkelmBackend & { calls: AgentRequest[] }
}

describe('agent() vision capability enforcement', () => {
  it('forwards image-bearing prompts to a vision-capable backend', async () => {
    const backend = makeAgentBackend({ id: 'vision-agent', vision: true })
    const reg = new BackendRegistry()
    reg.register(backend)

    const wf = pipeline({
      id: 'agent-vision-ok',
      steps: [
        agent({
          id: 'see',
          backend: 'vision-agent',
          prompt: [
            { type: 'text', text: 'describe this' },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          ],
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })
    expect(run.status).toBe('completed')
    expect(backend.calls).toHaveLength(1)
    expect(Array.isArray(backend.calls[0]?.prompt)).toBe(true)
  })

  it('rejects image-bearing prompts on backends that do not declare vision', async () => {
    const backend = makeAgentBackend({ id: 'text-only-agent' })
    const reg = new BackendRegistry()
    reg.register(backend)

    const wf = pipeline({
      id: 'agent-vision-denied',
      steps: [
        agent({
          id: 'see',
          backend: 'text-only-agent',
          prompt: [
            { type: 'text', text: 'describe this' },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          ],
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendCapabilityError')
    expect(backend.calls).toHaveLength(0)
  })
})
