import { describe, expect, it } from 'vitest'
import {
  type AgentRequest,
  type AgentResponse,
  type BackendCapabilities,
  type BackendContext,
  BackendRegistry,
  type InferenceRequest,
  type InferenceResponse,
  type SkelmBackend,
} from '../src/backend.js'
import { agent, infer, pipeline } from '../src/builders.js'
import { runPipeline } from '../src/runner.js'

const caps: BackendCapabilities = {
  prompt: true,
  streaming: false,
  sessionLifecycle: false,
  mcp: false,
  skills: false,
  modelSelection: true,
  toolPermissions: 'unsupported',
}

function inferBackend(id: string, impl: () => InferenceResponse | Promise<InferenceResponse>) {
  let calls = 0
  const b: SkelmBackend & { readonly count: () => number } = {
    id,
    capabilities: caps,
    count: () => calls,
    async inference(_req: InferenceRequest, _ctx: BackendContext) {
      calls++
      return impl()
    },
  }
  return b
}

function agentBackend(id: string, impl: () => AgentResponse | Promise<AgentResponse>) {
  let calls = 0
  const b: SkelmBackend & { readonly count: () => number } = {
    id,
    capabilities: caps,
    count: () => calls,
    async run(_req: AgentRequest, _ctx: BackendContext) {
      calls++
      return impl()
    },
  }
  return b
}

describe('step-level backend fallback (end to end)', () => {
  it('infer() falls over to the next backend when the first errors', async () => {
    const a = inferBackend('a', () => {
      throw new Error('a down')
    })
    const b = inferBackend('b', () => ({ text: 'from-b' }))
    const reg = new BackendRegistry()
    reg.register(a)
    reg.register(b)

    const wf = pipeline({
      id: 'infer-fallover',
      steps: [infer({ id: 's', backend: ['a', 'b'], prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(a.count()).toBe(1)
    expect(b.count()).toBe(1)
  })

  it('agent() falls over to the next backend when the first errors', async () => {
    const a = agentBackend('a', () => {
      throw new Error('a down')
    })
    const b = agentBackend('b', () => ({ text: 'from-b' }))
    const reg = new BackendRegistry()
    reg.register(a)
    reg.register(b)

    const wf = pipeline({
      id: 'agent-fallover',
      steps: [agent({ id: 's', backend: ['a', 'b'], prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(a.count()).toBe(1)
    expect(b.count()).toBe(1)
  })

  it('fails the step with BackendChainExhaustedError when every backend errors', async () => {
    const a = inferBackend('a', () => {
      throw new Error('a down')
    })
    const b = inferBackend('b', () => {
      throw new Error('b down')
    })
    const reg = new BackendRegistry()
    reg.register(a)
    reg.register(b)

    const wf = pipeline({
      id: 'infer-exhausted',
      steps: [infer({ id: 's', backend: ['a', 'b'], prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendChainExhaustedError')
  })
})
