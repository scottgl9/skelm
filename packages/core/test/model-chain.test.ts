import { describe, expect, it } from 'vitest'
import { BackendRegistry } from '../src/backend.js'
import { infer, pipeline } from '../src/builders.js'
import { ModelChainExhaustedError } from '../src/errors.js'
import { runWithModelFallback } from '../src/execution/model-chain.js'
import { runPipeline } from '../src/runner.js'
import { fixtureBackend } from '../src/testing/contract.js'

describe('runWithModelFallback', () => {
  it('returns the first model that succeeds', async () => {
    const tried: string[] = []
    const out = await runWithModelFallback('s', ['a', 'b', 'c'], async (m) => {
      tried.push(m)
      if (m === 'a') throw new Error('a unavailable')
      return `served-by-${m}`
    })
    expect(out).toBe('served-by-b')
    expect(tried).toEqual(['a', 'b'])
  })

  it('throws ModelChainExhaustedError with ordered attempts when all fail', async () => {
    const err = await runWithModelFallback('my-step', ['a', 'b'], async (m) => {
      throw new Error(`${m} down`)
    }).catch((e: unknown) => e as ModelChainExhaustedError)
    expect(err).toBeInstanceOf(ModelChainExhaustedError)
    expect(err?.stepId).toBe('my-step')
    expect(err?.attempts.map((a) => a.model)).toEqual(['a', 'b'])
  })
})

describe('infer() model fallback (end to end)', () => {
  it('falls over to the next model on the same backend when the first errors', async () => {
    const backend = fixtureBackend({
      id: 'llm',
      respond: (req) => {
        if (req.model === 'm1') throw new Error('m1 overloaded')
        return { text: `served-by-${req.model}` }
      },
    })
    const reg = new BackendRegistry()
    reg.register(backend)

    const wf = pipeline({
      id: 'model-fallover',
      output: undefined,
      steps: [infer({ id: 's', backend: 'llm', model: ['m1', 'm2'], prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(backend.calls.map((c) => c.model)).toEqual(['m1', 'm2'])
  })

  it('fails the step with ModelChainExhaustedError when every model errors', async () => {
    const backend = fixtureBackend({
      id: 'llm',
      respond: (req) => {
        throw new Error(`${req.model} down`)
      },
    })
    const reg = new BackendRegistry()
    reg.register(backend)

    const wf = pipeline({
      id: 'model-exhausted',
      steps: [infer({ id: 's', backend: 'llm', model: ['m1', 'm2'], prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('ModelChainExhaustedError')
  })

  it('a single model string sends exactly that model (no fallback wrapper)', async () => {
    const backend = fixtureBackend({ id: 'llm', respond: (req) => ({ text: `m=${req.model}` }) })
    const reg = new BackendRegistry()
    reg.register(backend)

    const wf = pipeline({
      id: 'single-model',
      steps: [infer({ id: 's', backend: 'llm', model: 'only', prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0]?.model).toBe('only')
  })

  it('rejects a multi-model list on a backend that does not honor model selection', async () => {
    const backend = fixtureBackend({
      id: 'llm',
      capabilities: { modelSelection: false },
      respond: () => ({ text: 'unused' }),
    })
    const reg = new BackendRegistry()
    reg.register(backend)

    const wf = pipeline({
      id: 'no-model-selection',
      steps: [infer({ id: 's', backend: 'llm', model: ['m1', 'm2'], prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendCapabilityError')
    // It must fail closed BEFORE calling the backend.
    expect(backend.calls).toHaveLength(0)
  })
})
