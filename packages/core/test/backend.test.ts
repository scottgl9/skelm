import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BackendAuthenticationError,
  BackendCapabilityError,
  BackendNotFoundError,
  BackendRegistry,
  BackendUnavailableError,
  type SkelmBackend,
} from '../src/backend.js'
import { agent, code, infer, pipeline } from '../src/builders.js'
import type { AuditEvent, AuditWriter } from '../src/enforcement/audit-writer.js'
import { EventBus, type RunEvent } from '../src/events.js'
import { runPipeline } from '../src/runner.js'
import { fixtureBackend } from '../src/testing/contract.js'

describe('BackendRegistry', () => {
  it('rejects duplicate registration of the same id', () => {
    const reg = new BackendRegistry()
    const a = fixtureBackend({ id: 'foo', respond: () => ({ text: 'a' }) })
    const b = fixtureBackend({ id: 'foo', respond: () => ({ text: 'b' }) })
    reg.register(a)
    expect(() => reg.register(b)).toThrow(/already registered/)
  })

  it('has reflects whether an id is registered', () => {
    const reg = new BackendRegistry()
    expect(reg.has('foo')).toBe(false)
    reg.register(fixtureBackend({ id: 'foo', respond: () => ({ text: 'a' }) }))
    expect(reg.has('foo')).toBe(true)
  })

  it('registerIfAbsent adds a new id and reports "registered"', () => {
    const reg = new BackendRegistry()
    const a = fixtureBackend({ id: 'foo', respond: () => ({ text: 'a' }) })
    expect(reg.registerIfAbsent(a)).toBe('registered')
    expect(reg.resolveForLlm({ backendId: 'foo' })).toBe(a)
  })

  it('registerIfAbsent leaves an existing id untouched and reports "exists"', () => {
    const reg = new BackendRegistry()
    const a = fixtureBackend({ id: 'foo', respond: () => ({ text: 'a' }) })
    const b = fixtureBackend({ id: 'foo', respond: () => ({ text: 'b' }) })
    reg.register(a)
    expect(reg.registerIfAbsent(b)).toBe('exists')
    expect(reg.resolveForLlm({ backendId: 'foo' })).toBe(a)
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

describe('infer() step', () => {
  it('runs an infer step against a fixture backend (text output)', async () => {
    const reg = new BackendRegistry()
    reg.register(
      fixtureBackend({
        id: 'fake',
        respond: (req) => ({ text: `echo:${req.messages[0]?.content}` }),
      }),
    )

    const wf = pipeline({
      id: 'inference-text',
      steps: [infer({ id: 'say', backend: 'fake', prompt: 'hello' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ text: 'echo:hello', usage: undefined })
  })

  it('runs an infer step with a structured output schema', async () => {
    const reg = new BackendRegistry()
    reg.register(
      fixtureBackend({
        id: 'fake',
        respond: () => ({ structured: { label: 'bug', confidence: 0.9 } }),
      }),
    )

    const wf = pipeline({
      id: 'inference-struct',
      steps: [
        infer({
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
      id: 'inference-prompt-fn',
      input: z.object({ name: z.string() }),
      steps: [
        infer({
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

  it('forwards image content parts to vision-capable backends', async () => {
    const reg = new BackendRegistry()
    const seen: unknown[] = []
    reg.register(
      fixtureBackend({
        id: 'vision-ok',
        capabilities: { vision: true },
        respond: (req) => {
          seen.push(req.messages[0]?.content)
          return { text: 'described' }
        },
      }),
    )

    const wf = pipeline({
      id: 'inference-image',
      steps: [
        infer({
          id: 'describe',
          backend: 'vision-ok',
          prompt: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          ],
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(seen).toHaveLength(1)
    expect(Array.isArray(seen[0])).toBe(true)
  })

  it('rejects image prompts against non-vision backends with BackendCapabilityError', async () => {
    const reg = new BackendRegistry()
    reg.register(
      fixtureBackend({
        // capabilities.vision defaults to undefined / false
        id: 'no-vision',
        respond: () => ({ text: 'nope' }),
      }),
    )

    const wf = pipeline({
      id: 'inference-image-denied',
      steps: [
        infer({
          id: 'describe',
          backend: 'no-vision',
          prompt: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          ],
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendCapabilityError')
    expect(run.error?.message).toMatch(/does not support image content/)
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
        infer({
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
      steps: [infer({ id: 'say', prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendNotFoundError')
  })

  it('mixes code and infer steps; ctx.steps[id] sees the inference output', async () => {
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
        infer({
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

describe('backend list fallback', () => {
  class CapturingAuditWriter implements AuditWriter {
    readonly entries: AuditEvent[] = []
    async write(entry: AuditEvent): Promise<void> {
      this.entries.push(entry)
    }
  }

  function agentBackend(id: string, run: NonNullable<SkelmBackend['run']>): SkelmBackend {
    return {
      id,
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      run,
    }
  }

  it('falls over to the next agent backend when the first is unavailable', async () => {
    const calls: string[] = []
    const reg = new BackendRegistry()
    reg.register(
      agentBackend('missing-agent', async () => {
        calls.push('missing-agent')
        throw new BackendUnavailableError('agent not installed', 'missing-agent')
      }),
    )
    reg.register(
      agentBackend('working-agent', async () => {
        calls.push('working-agent')
        return { text: 'ok' }
      }),
    )

    const wf = pipeline({
      id: 'agent-backend-list',
      steps: [
        agent({
          id: 'work',
          backend: ['missing-agent', 'working-agent'],
          prompt: 'hello',
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ text: 'ok' })
    expect(calls).toEqual(['missing-agent', 'working-agent'])
  })

  it('emits and audits agent backend failover', async () => {
    const reg = new BackendRegistry()
    reg.register(
      agentBackend('missing-agent', async () => {
        throw new BackendUnavailableError('agent not installed', 'missing-agent')
      }),
    )
    reg.register(agentBackend('working-agent', async () => ({ text: 'ok' })))
    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((event) => seen.push(event))
    const auditWriter = new CapturingAuditWriter()

    const wf = pipeline({
      id: 'agent-backend-list-audit',
      steps: [
        agent({
          id: 'work',
          backend: ['missing-agent', 'working-agent'],
          prompt: 'hello',
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends: reg, events, auditWriter })

    expect(run.status).toBe('completed')
    const event = seen.find(
      (e): e is Extract<RunEvent, { type: 'backend.failover' }> => e.type === 'backend.failover',
    )
    expect(event).toMatchObject({
      type: 'backend.failover',
      stepId: 'work',
      kind: 'agent',
      from: 'missing-agent',
      to: 'working-agent',
      error: 'agent not installed',
    })
    expect(auditWriter.entries).toContainEqual(
      expect.objectContaining({
        action: 'backend.failover',
        actor: 'runtime',
        details: expect.objectContaining({
          stepId: 'work',
          kind: 'agent',
          from: 'missing-agent',
          to: 'working-agent',
          error: 'agent not installed',
        }),
      }),
    )
  })

  it('falls over to the next infer backend when the first is unavailable', async () => {
    const calls: string[] = []
    const reg = new BackendRegistry()
    reg.register(
      fixtureBackend({
        id: 'missing-infer',
        respond: async () => {
          calls.push('missing-infer')
          throw new BackendUnavailableError('infer not installed', 'missing-infer')
        },
      }),
    )
    reg.register(
      fixtureBackend({
        id: 'working-infer',
        respond: () => {
          calls.push('working-infer')
          return { text: 'ok' }
        },
      }),
    )

    const wf = pipeline({
      id: 'infer-backend-list',
      steps: [infer({ id: 'ask', backend: ['missing-infer', 'working-infer'], prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ text: 'ok', usage: undefined })
    expect(calls).toEqual(['missing-infer', 'working-infer'])
  })

  it('fails a single unavailable backend without trying registry fallback', async () => {
    const reg = new BackendRegistry()
    reg.register(
      agentBackend('missing-agent', async () => {
        throw new BackendUnavailableError('agent not installed', 'missing-agent')
      }),
    )
    reg.register(agentBackend('working-agent', async () => ({ text: 'unreachable' })))

    const wf = pipeline({
      id: 'single-unavailable-agent',
      steps: [agent({ id: 'work', backend: 'missing-agent', prompt: 'hello' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendUnavailableError')
    expect(run.error?.message).toContain('agent not installed')
  })

  it('preserves BackendUnavailableError for an unavailable default infer backend', async () => {
    const reg = new BackendRegistry()
    reg.register(
      fixtureBackend({
        id: 'missing-infer',
        respond: async () => {
          throw new BackendUnavailableError('infer not installed', 'missing-infer')
        },
      }),
    )

    const wf = pipeline({
      id: 'default-infer-unavailable',
      steps: [infer({ id: 'ask', prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, {
      backends: reg,
      defaultInferBackend: 'missing-infer',
    })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendUnavailableError')
    expect(run.error?.message).toContain('infer not installed')
  })

  it('does not fall over on non-availability backend errors', async () => {
    const calls: string[] = []
    const reg = new BackendRegistry()
    reg.register(
      agentBackend('bad-auth', async () => {
        calls.push('bad-auth')
        throw new BackendAuthenticationError('bad key', 'bad-auth')
      }),
    )
    reg.register(
      agentBackend('working-agent', async () => {
        calls.push('working-agent')
        return { text: 'unreachable' }
      }),
    )

    const wf = pipeline({
      id: 'agent-backend-list-auth',
      steps: [agent({ id: 'work', backend: ['bad-auth', 'working-agent'], prompt: 'hello' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendAuthenticationError')
    expect(calls).toEqual(['bad-auth'])
  })

  it('skips unknown ids in an explicit list when a later backend works', async () => {
    const reg = new BackendRegistry()
    reg.register(agentBackend('working-agent', async () => ({ text: 'ok' })))

    const wf = pipeline({
      id: 'agent-backend-list-unknown',
      steps: [agent({ id: 'work', backend: ['unknown-agent', 'working-agent'], prompt: 'hello' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ text: 'ok' })
  })
})
