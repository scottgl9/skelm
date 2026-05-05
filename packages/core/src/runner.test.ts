import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from './backend.js'
import { agent, code, pipeline } from './builders.js'
import { MissingSecretError, type SecretResolver } from './enforcement/index.js'
import { EventBus, type RunEvent } from './events.js'
import { runPipeline } from './runner.js'

describe('runPipeline — sequential code steps', () => {
  it('runs a single code step and adopts its output as the run output', async () => {
    const wf = pipeline<{ name: string }, { greeting: string }>({
      id: 'hello',
      steps: [
        code({
          id: 'greet',
          run: (ctx) => ({ greeting: `hello, ${(ctx.input as { name: string }).name}` }),
        }),
      ],
    })

    const run = await runPipeline(wf, { name: 'world' })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ greeting: 'hello, world' })
    expect(run.steps).toHaveLength(1)
    expect(run.steps[0]?.status).toBe('completed')
    expect(run.error).toBeUndefined()
  })

  it('passes prior step outputs through ctx.steps to later steps', async () => {
    const wf = pipeline<unknown, { sum: number }>({
      id: 'add',
      steps: [
        code({ id: 'a', run: () => ({ value: 2 }) }),
        code({ id: 'b', run: () => ({ value: 3 }) }),
        code({
          id: 'sum',
          run: (ctx) => {
            const a = (ctx.steps.a as { value: number }).value
            const b = (ctx.steps.b as { value: number }).value
            return { sum: a + b }
          },
        }),
      ],
      finalize: (ctx) => ctx.steps.sum as { sum: number },
    })

    const run = await runPipeline(wf, undefined)

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ sum: 5 })
    expect(run.steps.map((s) => s.id)).toEqual(['a', 'b', 'sum'])
  })

  it('uses finalize to shape the output if provided', async () => {
    const wf = pipeline<unknown, { tag: string }>({
      id: 'tag',
      steps: [code({ id: 'identify', run: () => ({ kind: 'workflow' }) })],
      finalize: (ctx) => ({ tag: `[${(ctx.steps.identify as { kind: string }).kind}]` }),
    })

    const run = await runPipeline(wf, undefined)
    expect(run.output).toEqual({ tag: '[workflow]' })
  })

  it('marks the run failed and records a step error when a code step throws', async () => {
    const wf = pipeline<unknown, unknown>({
      id: 'boom',
      steps: [
        code({ id: 'ok', run: () => ({}) }),
        code({
          id: 'kaboom',
          run: () => {
            throw new Error('intentional')
          },
        }),
        code({ id: 'never', run: () => ({}) }),
      ],
    })

    const run = await runPipeline(wf, undefined)

    expect(run.status).toBe('failed')
    expect(run.output).toBeUndefined()
    expect(run.error?.message).toBe('intentional')
    expect(run.steps.map((s) => s.id)).toEqual(['ok', 'kaboom'])
    expect(run.steps[1]?.status).toBe('failed')
    expect(run.steps[1]?.error?.message).toBe('intentional')
  })

  it('does not start a step when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const wf = pipeline<unknown, unknown>({
      id: 'pre-aborted',
      steps: [code({ id: 'noop', run: () => ({}) })],
    })

    const run = await runPipeline(wf, undefined, { signal: controller.signal })
    expect(run.status).toBe('cancelled')
    expect(run.steps).toHaveLength(0)
  })

  it('exposes the pipelineId, runId, and timestamps on the Run record', async () => {
    const wf = pipeline<unknown, unknown>({
      id: 'meta',
      steps: [code({ id: 'noop', run: () => ({}) })],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.pipelineId).toBe('meta')
    expect(run.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(run.startedAt).toBeGreaterThan(0)
    expect(run.completedAt).toBeGreaterThanOrEqual(run.startedAt)
  })
})

describe('builders — validation', () => {
  it('rejects a pipeline with no steps', () => {
    expect(() => pipeline<unknown, unknown>({ id: 'empty', steps: [] })).toThrow(
      /at least one step/,
    )
  })

  it('rejects duplicate step ids', () => {
    expect(() =>
      pipeline<unknown, unknown>({
        id: 'dup',
        steps: [code({ id: 'x', run: () => ({}) }), code({ id: 'x', run: () => ({}) })],
      }),
    ).toThrow(/duplicate step id/)
  })

  it('rejects a code step with no run function', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse for the test
      code({ id: 'bad', run: undefined as any }),
    ).toThrow(/run must be a function/)
  })

  it('rejects an invalid retry policy', () => {
    expect(() => code({ id: 'bad-retry', retry: { maxAttempts: 0 }, run: () => ({}) })).toThrow(
      /retry\.maxAttempts must be >= 1/,
    )
  })
})

describe('retry policy', () => {
  it('retries a step until it succeeds and emits step.retry events', async () => {
    let attempts = 0
    const events = new EventBus()
    const retries: Array<{ attempt: number; delayMs?: number }> = []
    events.subscribe((event) => {
      if (event.type === 'step.retry') {
        retries.push({ attempt: event.attempt, delayMs: event.delayMs })
      }
    })

    const wf = pipeline({
      id: 'retry-success',
      steps: [
        code({
          id: 'flaky',
          retry: { maxAttempts: 3, delayMs: 0 },
          run: () => {
            attempts += 1
            if (attempts < 3) {
              throw new Error('transient')
            }
            return { ok: true }
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, { events })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ ok: true })
    expect(attempts).toBe(3)
    expect(retries).toEqual([{ attempt: 1 }, { attempt: 2 }])
  })

  it('fails after exhausting retry attempts', async () => {
    let attempts = 0
    const wf = pipeline({
      id: 'retry-fail',
      steps: [
        code({
          id: 'still-flaky',
          retry: { maxAttempts: 2 },
          run: () => {
            attempts += 1
            throw new Error('still broken')
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.message).toBe('still broken')
    expect(attempts).toBe(2)
  })
})

describe('runPipeline — agent secrets', () => {
  function captureBackend(captured: {
    secrets?: Readonly<Record<string, string>>
  }): SkelmBackend {
    return {
      id: 'sec-backend',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'wrapped',
      },
      async run(req) {
        captured.secrets = req.secrets
        return { text: 'ok' }
      },
    }
  }

  function memoryResolver(values: Record<string, string>): SecretResolver {
    return {
      async resolve(name) {
        return values[name]
      },
    }
  }

  it('resolves declared secrets and injects them into AgentRequest.secrets', async () => {
    const captured: { secrets?: Readonly<Record<string, string>> } = {}
    const registry = new BackendRegistry()
    registry.register(captureBackend(captured))
    const events = new EventBus()
    const accessed: RunEvent[] = []
    events.subscribe((e) => {
      if (e.type === 'secret.accessed') accessed.push(e)
    })
    const wf = pipeline({
      id: 'sec-ok',
      steps: [
        agent({
          id: 'work',
          backend: 'sec-backend',
          prompt: 'hi',
          secrets: ['JIRA_API_TOKEN'],
          permissions: { allowedSecrets: ['JIRA_API_TOKEN'] },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, {
      backends: registry,
      events,
      secretResolver: memoryResolver({ JIRA_API_TOKEN: 'super-sekrit' }),
    })
    expect(run.status).toBe('completed')
    expect(captured.secrets).toEqual({ JIRA_API_TOKEN: 'super-sekrit' })
    expect(accessed).toHaveLength(1)
    expect(accessed[0]).toMatchObject({ name: 'JIRA_API_TOKEN', stepId: 'work' })
  })

  it('denies an undeclared secret with permission.denied (dimension: secret) and never resolves it', async () => {
    const captured: { secrets?: Readonly<Record<string, string>> } = {}
    const registry = new BackendRegistry()
    registry.register(captureBackend(captured))
    const events = new EventBus()
    const denials: RunEvent[] = []
    let resolverCalls = 0
    events.subscribe((e) => {
      if (e.type === 'permission.denied') denials.push(e)
    })
    const wf = pipeline({
      id: 'sec-denied',
      steps: [
        agent({
          id: 'work',
          backend: 'sec-backend',
          prompt: 'hi',
          secrets: ['SHOULD_NOT_HAVE'],
          permissions: { allowedSecrets: ['ALLOWED'] },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, {
      backends: registry,
      events,
      secretResolver: {
        async resolve(_name) {
          resolverCalls += 1
          return 'leaked-value'
        },
      },
    })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(denials).toHaveLength(1)
    expect(denials[0]).toMatchObject({ dimension: 'secret', stepId: 'work' })
    expect(captured.secrets).toBeUndefined()
    expect(resolverCalls).toBe(0)
  })

  it('throws MissingSecretError when the resolver returns undefined for an allowed secret', async () => {
    const registry = new BackendRegistry()
    registry.register(captureBackend({}))
    const wf = pipeline({
      id: 'sec-missing',
      steps: [
        agent({
          id: 'work',
          backend: 'sec-backend',
          prompt: 'hi',
          secrets: ['NOT_IN_ENV'],
          permissions: { allowedSecrets: ['NOT_IN_ENV'] },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, {
      backends: registry,
      secretResolver: memoryResolver({}),
    })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('MissingSecretError')
  })

  it('never includes secret values in event payloads', async () => {
    const registry = new BackendRegistry()
    registry.register(captureBackend({}))
    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((e) => seen.push(e))
    const wf = pipeline({
      id: 'sec-no-leak',
      steps: [
        agent({
          id: 'work',
          backend: 'sec-backend',
          prompt: 'hi',
          secrets: ['LEAK_PROBE'],
          permissions: { allowedSecrets: ['LEAK_PROBE'] },
        }),
      ],
    })
    await runPipeline(wf, undefined, {
      backends: registry,
      events,
      secretResolver: memoryResolver({ LEAK_PROBE: 'TOPSECRET' }),
    })
    for (const ev of seen) {
      expect(JSON.stringify(ev)).not.toContain('TOPSECRET')
    }
  })

  it('MissingSecretError exposes the secret name', () => {
    const err = new MissingSecretError('FOO')
    expect(err.secretName).toBe('FOO')
  })
})
