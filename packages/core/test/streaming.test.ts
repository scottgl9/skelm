import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from '../src/backend.js'
import { code, infer, pipeline } from '../src/builders.js'
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
      async inference(req, ctx) {
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

  it('infer() step emits step.partial events when onPartial is provided', async () => {
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
        infer({
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

  it('delivers step.partial (and lifecycle) events to the onEvent run option', async () => {
    // Regression: the gateway plumbs a queue driver's onEvent hook into
    // runner.start({ onEvent }) (e.g. a TUI frontend streaming a turn), but the
    // option was never consumed — so streaming frontends received nothing. The
    // onEvent listener must be subscribed to the run's bus without the caller
    // having to own the whole `events` bus.
    const chunks = ['Hel', 'lo ', 'wor', 'ld']
    const registry = new BackendRegistry()
    registry.register(streamingLlmBackend(chunks))

    const received: RunEvent[] = []
    const wf = pipeline({
      id: 'onevent-stream',
      steps: [infer({ id: 'stream-step', backend: 'streaming-llm', prompt: 'say hello' })],
    })

    const run = await runPipeline(
      wf,
      {},
      {
        backends: registry,
        // No `events` bus supplied — onEvent must still be wired to the bus the
        // runner creates internally.
        onEvent: (ev) => received.push(ev),
      },
    )

    expect(run.status).toBe('completed')
    const partials = received.filter((e) => e.type === 'step.partial').map((e) => e.delta)
    expect(partials).toEqual(chunks)
    // onEvent sees the full lifecycle, not just partials.
    expect(received.some((e) => e.type === 'run.completed')).toBe(true)
  })

  it('infer() step without events bus does not emit step.partial events', async () => {
    const chunks = ['Hello', ' ', 'world', '!']
    const registry = new BackendRegistry()
    registry.register(streamingLlmBackend(chunks))

    const wf = pipeline({
      id: 'no-events',
      steps: [
        infer({
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
