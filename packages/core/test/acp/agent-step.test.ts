import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAcpBackend } from '../../src/acp/backend.js'
import { BackendRegistry } from '../../src/backend.js'
import { agent, pipeline } from '../../src/builders.js'
import { runPipeline } from '../../src/runner.js'

const MOCK_AGENT = fileURLToPath(new URL('./mock-acp-agent.ts', import.meta.url))

describe('agent() step + ACP backend', () => {
  it('runs an agent step end-to-end against the mock ACP agent', async () => {
    const reg = new BackendRegistry()
    reg.register(
      createAcpBackend({
        id: 'acp-mock',
        command: 'node',
        args: ['--import', 'tsx/esm', MOCK_AGENT],
      }),
    )

    const wf = pipeline({
      id: 'agent-mock',
      steps: [agent({ id: 'work', backend: 'acp-mock', prompt: 'hello mock' })],
    })

    const run = await runPipeline(wf, undefined, { backends: reg })
    expect(run.status).toBe('completed')
    const out = run.output as { text: string; stopReason?: string }
    expect(out.text).toBe('echo:hello mock')
    expect(out.stopReason).toBe('end_turn')
  })

  it('honors structured output schemas', async () => {
    const reg = new BackendRegistry()
    reg.register(
      createAcpBackend({
        id: 'acp-mock',
        command: 'node',
        args: ['--import', 'tsx/esm', MOCK_AGENT],
      }),
    )

    const wf = pipeline({
      id: 'agent-struct',
      steps: [
        agent({
          id: 'classify',
          backend: 'acp-mock',
          prompt: '{"label":"feature"}',
          // The mock echoes "echo:" + prompt, which doesn't match this schema —
          // so this asserts the negative path: structured-output validation
          // catches a non-conforming agent reply.
          output: z.object({ label: z.string() }),
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, { backends: reg })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('SchemaValidationError')
  })

  it('passes ctx through prompt callbacks', async () => {
    const reg = new BackendRegistry()
    reg.register(
      createAcpBackend({
        id: 'acp-mock',
        command: 'node',
        args: ['--import', 'tsx/esm', MOCK_AGENT],
      }),
    )

    const wf = pipeline({
      id: 'agent-ctx',
      input: z.object({ name: z.string() }),
      steps: [
        agent({
          id: 'greet',
          backend: 'acp-mock',
          prompt: (ctx) => `hi ${(ctx.input as { name: string }).name}`,
        }),
      ],
    })

    const run = await runPipeline(wf, { name: 'world' }, { backends: reg })
    expect(run.status).toBe('completed')
    expect((run.output as { text: string }).text).toBe('echo:hi world')
  })
})
