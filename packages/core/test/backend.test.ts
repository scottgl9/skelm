import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BackendCapabilityError, BackendNotFoundError, BackendRegistry } from '../src/backend.js'
import { code, llm, pipeline } from '../src/builders.js'
import { runPipeline } from '../src/runner.js'
import { fixtureBackend } from '../src/testing.js'

describe('BackendRegistry', () => {
  it('rejects duplicate registration of the same id', () => {
    const reg = new BackendRegistry()
    const a = fixtureBackend({ id: 'foo', respond: () => ({ text: 'a' }) })
    const b = fixtureBackend({ id: 'foo', respond: () => ({ text: 'b' }) })
    reg.register(a)
    expect(() => reg.register(b)).toThrow(/already registered/)
  })

  it('resolveForLlm returns the backend by id', () => {
    const reg = new BackendRegistry()
    const a = fixtureBackend({ id: 'a', respond: () => ({ text: 'A' }) })
    reg.register(a)
    expect(reg.resolveForLlm({ backendId: 'a' })).toBe(a)
  })

  it('resolveForLlm throws when the id is unknown', () => {
    const reg = new BackendRegistry()
    expect(() => reg.resolveForLlm({ backendId: 'nope' })).toThrow(BackendNotFoundError)
  })

  it('resolveForLlm throws when the named backend lacks prompt capability', () => {
    const reg = new BackendRegistry()
    const a = fixtureBackend({
      id: 'noprompt',
      capabilities: { prompt: false },
      respond: () => ({ text: '' }),
    })
    reg.register(a)
    expect(() => reg.resolveForLlm({ backendId: 'noprompt' })).toThrow(BackendCapabilityError)
  })

  it('resolveForLlm falls back to the first prompt-capable backend', () => {
    const reg = new BackendRegistry()
    const a = fixtureBackend({ id: 'a', respond: () => ({ text: 'A' }) })
    const b = fixtureBackend({ id: 'b', respond: () => ({ text: 'B' }) })
    reg.register(a)
    reg.register(b)
    expect(reg.resolveForLlm({})).toBe(a)
  })
})

describe('llm() step', () => {
  it('runs an llm step against a fixture backend (text output)', async () => {
    const reg = new BackendRegistry()
    reg.register(
      fixtureBackend({
        id: 'fake',
        respond: (req) => ({ text: `echo:${req.messages[0]?.content}` }),
      }),
    )

    const wf = pipeline({
      id: 'llm-text',
      steps: [llm({ id: 'say', backend: 'fake', prompt: 'hello' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ text: 'echo:hello', usage: undefined })
  })

  it('runs an llm step with a structured output schema', async () => {
    const reg = new BackendRegistry()
    reg.register(
      fixtureBackend({
        id: 'fake',
        respond: () => ({ structured: { label: 'bug', confidence: 0.9 } }),
      }),
    )

    const wf = pipeline({
      id: 'llm-struct',
      steps: [
        llm({
          id: 'classify',
          backend: 'fake',
          prompt: 'classify',
          output: z.object({ label: z.string(), confidence: z.number() }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ label: 'bug', confidence: 0.9 })
  })

  it('passes ctx through prompt callbacks', async () => {
    const reg = new BackendRegistry()
    reg.register(
      fixtureBackend({
        id: 'fake',
        respond: (req) => ({ text: req.messages[0]?.content ?? '' }),
      }),
    )

    const wf = pipeline({
      id: 'llm-prompt-fn',
      input: z.object({ name: z.string() }),
      steps: [
        llm({
          id: 'greet',
          backend: 'fake',
          prompt: (ctx) => `hello, ${(ctx.input as { name: string }).name}`,
        }),
      ],
    })
    const run = await runPipeline(wf, { name: 'world' }, { backends: reg })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ text: 'hello, world', usage: undefined })
  })

  it('fails the run when the structured response does not match the output schema', async () => {
    const reg = new BackendRegistry()
    reg.register(
      fixtureBackend({
        id: 'fake',
        respond: () => ({ structured: { label: 'bug' } }), // missing confidence
      }),
    )

    const wf = pipeline({
      id: 'bad-struct',
      steps: [
        llm({
          id: 'classify',
          backend: 'fake',
          prompt: 'x',
          output: z.object({ label: z.string(), confidence: z.number() }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('SchemaValidationError')
  })

  it('fails the run when no backend registry is provided to runPipeline', async () => {
    const wf = pipeline({
      id: 'no-reg',
      steps: [llm({ id: 'say', prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendNotFoundError')
  })

  it('mixes code and llm steps; ctx.steps[id] sees the llm output', async () => {
    const reg = new BackendRegistry()
    reg.register(
      fixtureBackend({
        id: 'fake',
        respond: () => ({ structured: { label: 'feature' } }),
      }),
    )

    const wf = pipeline({
      id: 'mix',
      steps: [
        llm({
          id: 'classify',
          backend: 'fake',
          prompt: 'x',
          output: z.object({ label: z.string() }),
        }),
        code({
          id: 'log',
          run: (ctx) => ({
            classified: (ctx.steps.classify as { label: string }).label,
          }),
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ classified: 'feature' })
  })
})
