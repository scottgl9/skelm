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

/**
 * Mock agent backend whose run() resolves after `delayMs`, but bails early when
 * the context signal aborts — i.e. the well-behaved shape any HTTP-driven
 * backend would have (chatCompletion → fetch(signal)).
 */
function slowAgentBackend(opts: { id: string; delayMs: number }): SkelmBackend {
  const capabilities: BackendCapabilities = {
    prompt: false,
    streaming: false,
    sessionLifecycle: false,
    mcp: false,
    skills: false,
    modelSelection: false,
    toolPermissions: 'native',
  }
  return {
    id: opts.id,
    capabilities,
    async run(_req: AgentRequest, ctx: BackendContext): Promise<AgentResponse> {
      return await new Promise<AgentResponse>((resolve, reject) => {
        const t = setTimeout(() => resolve({ text: 'slow-ok' }), opts.delayMs)
        const onAbort = () => {
          clearTimeout(t)
          reject(ctx.signal.reason ?? new Error('aborted'))
        }
        if (ctx.signal.aborted) onAbort()
        else ctx.signal.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

describe('agent step timeoutMs', () => {
  it('aborts a long-running agent step at the declared timeoutMs', async () => {
    const reg = new BackendRegistry()
    reg.register(slowAgentBackend({ id: 'slow', delayMs: 2_000 }))

    const wf = pipeline({
      id: 'timeout-wf',
      steps: [
        agent({
          id: 'too-slow',
          backend: 'slow',
          prompt: 'noop',
          timeoutMs: 50,
        }),
      ],
    })

    const t0 = Date.now()
    const run = await runPipeline(wf, undefined, { backends: reg })
    const elapsed = Date.now() - t0

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('StepTimeoutError')
    expect(run.error?.message).toMatch(/exceeded its 50ms timeout/)
    // Step must fail well before the backend would have resolved.
    expect(elapsed).toBeLessThan(1_500)
  })

  it('lets fast agent steps complete normally when timeoutMs is generous', async () => {
    const reg = new BackendRegistry()
    reg.register(slowAgentBackend({ id: 'slow', delayMs: 25 }))

    const wf = pipeline({
      id: 'timeout-ok',
      steps: [
        agent({
          id: 'fast',
          backend: 'slow',
          prompt: 'noop',
          timeoutMs: 1_000,
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(run.output).toMatchObject({ text: 'slow-ok' })
  })
})
