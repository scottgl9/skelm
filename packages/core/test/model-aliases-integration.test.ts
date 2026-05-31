import { describe, expect, it } from 'vitest'
import { BackendRegistry, type InferenceRequest, type SkelmBackend } from '../src/backend.js'
import { infer, pipeline } from '../src/builders.js'
import { runPipeline } from '../src/runner.js'

/** Capture the last InferenceRequest sent to a mock backend. */
function captureBackend(id: string): SkelmBackend & { captured: InferenceRequest[] } {
  const captured: InferenceRequest[] = []
  return {
    id,
    capabilities: { prompt: true },
    async inference(req: InferenceRequest) {
      captured.push(req)
      return { text: 'ok' }
    },
    captured,
  } as unknown as SkelmBackend & { captured: InferenceRequest[] }
}

describe('model alias — runner integration', () => {
  it('resolves alias model string before forwarding to the backend', async () => {
    const backend = captureBackend('openai')
    const registry = new BackendRegistry({
      models: { fast: { backend: 'openai', model: 'gpt-4o-mini' } },
    })
    registry.register(backend)

    const wf = pipeline({
      id: 'alias-test',
      steps: [infer({ id: 'step1', model: 'fast', prompt: 'hello' })],
    })

    await runPipeline(wf, undefined, { backends: registry })

    expect(backend.captured).toHaveLength(1)
    expect(backend.captured[0].model).toBe('gpt-4o-mini')
  })

  it('forwards a bare model string unchanged when it is not a registered alias', async () => {
    const backend = captureBackend('openai')
    const registry = new BackendRegistry({
      models: { fast: { backend: 'openai', model: 'gpt-4o-mini' } },
    })
    registry.register(backend)

    const wf = pipeline({
      id: 'bare-model-test',
      steps: [infer({ id: 'step1', model: 'gpt-4o', prompt: 'hello' })],
    })

    await runPipeline(wf, undefined, { backends: registry })

    expect(backend.captured[0].model).toBe('gpt-4o')
  })

  it('alias backend override routes to the correct backend', async () => {
    const cheap = captureBackend('cheap')
    const expensive = captureBackend('expensive')
    const registry = new BackendRegistry({
      models: { fast: { backend: 'cheap', model: 'gpt-4o-mini' } },
    })
    registry.register(cheap)
    registry.register(expensive)

    const wf = pipeline({
      id: 'alias-backend-test',
      // step has no explicit backend — alias provides it
      steps: [infer({ id: 'step1', model: 'fast', prompt: 'hello' })],
    })

    await runPipeline(wf, undefined, { backends: registry })

    expect(cheap.captured).toHaveLength(1)
    expect(expensive.captured).toHaveLength(0)
    expect(cheap.captured[0].model).toBe('gpt-4o-mini')
  })

  it('alias without backend field uses step backend resolution (first capable)', async () => {
    const backend = captureBackend('openai')
    const registry = new BackendRegistry({
      models: { smart: { model: 'gpt-4o' } },  // no backend pin
    })
    registry.register(backend)

    const wf = pipeline({
      id: 'no-backend-alias-test',
      steps: [infer({ id: 'step1', model: 'smart', prompt: 'hello' })],
    })

    await runPipeline(wf, undefined, { backends: registry })

    expect(backend.captured[0].model).toBe('gpt-4o')
  })
})
