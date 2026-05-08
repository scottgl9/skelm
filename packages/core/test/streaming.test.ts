import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from '../src/backend.js'
import { code, llm, pipeline } from '../src/builders.js'
import { EventBus } from '../src/events.js'
import type { RunEvent } from '../src/events.js'
import { runPipeline } from '../src/runner.js'

describe('streaming output — step.partial events', () => {
  function streamingLlmBackend(chunks: readonly string[]): SkelmBackend {
    return {
      id: 'streaming-llm',
      capabilities: {
        prompt: true,
        streaming: true,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      async infer(req, ctx) {
        // Simulate streaming by calling onPartial with each chunk
        if (ctx.onPartial !== undefined) {
          for (const chunk of chunks) {
            ctx.onPartial(chunk)
          }
        }
        return { text: chunks.join('') }
      },
    }
  }

  it('llm() step emits step.partial events when onPartial is provided', async () => {
    const chunks = ['Hello', ' ', 'world', '!']
    const registry = new BackendRegistry()
    registry.register(streamingLlmBackend(chunks))

    const events = new EventBus()
    const partialDeltas: string[] = []
    events.subscribe((ev) => {
      if (ev.type === 'step.partial') {
        partialDeltas.push(ev.delta)
      }
    })

    const wf = pipeline({
      id: 'streaming-llm',
      steps: [
        llm({
          id: 'stream-step',
          backend: 'streaming-llm',
          prompt: 'say hello',
        }),
      ],
    })

    const run = await runPipeline(
      wf,
      {},
      {
        backends: registry,
        events,
      },
    )

    expect(run.status).toBe('completed')
    expect((run.output as { text: string }).text).toBe('Hello world!')
    expect(partialDeltas).toEqual(chunks)
  })

  it('llm() step without events bus does not emit step.partial events', async () => {
    const chunks = ['Hello', ' ', 'world', '!']
    const registry = new BackendRegistry()
    registry.register(streamingLlmBackend(chunks))

    const wf = pipeline({
      id: 'no-events',
      steps: [
        llm({
          id: 'stream-step',
          backend: 'streaming-llm',
          prompt: 'say hello',
        }),
      ],
    })

    const run = await runPipeline(wf, {}, { backends: registry })

    expect(run.status).toBe('completed')
    expect((run.output as { text: string }).text).toBe('Hello world!')
  })
})
