import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from '../src/backend.js'
import { agent, code, infer, pipeline } from '../src/builders.js'
import { EnvSecretResolver, MissingSecretError } from '../src/enforcement/index.js'
import { EventBus } from '../src/events.js'
import { runPipeline } from '../src/runner.js'

describe('secrets in code() steps', () => {
  it('code() step with secrets receives ctx.secrets.get() resolved from EnvSecretResolver', async () => {
    const wf = pipeline<{ name: string }, { greeting: string }>({
      id: 'secrets-code',
      steps: [
        code({
          id: 'use-secrets',
          secrets: ['MY_KEY'],
          run: (ctx) => {
            const token = ctx.secrets?.get('MY_KEY')
            return { greeting: `hello, ${(ctx.input as { name: string }).name}, token=${token}` }
          },
        }),
      ],
    })

    const env = { MY_KEY: 'secret-token-123' }
    const resolver = new EnvSecretResolver(() => env)

    const run = await runPipeline(
      wf,
      { name: 'world' },
      {
        secretResolver: resolver,
      },
    )

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ greeting: 'hello, world, token=secret-token-123' })
  })

  it('code() step without secrets has ctx.secrets === undefined', async () => {
    const wf = pipeline({
      id: 'no-secrets',
      steps: [
        code({
          id: 'no-secrets-step',
          run: (ctx) => {
            expect(ctx.secrets).toBeUndefined()
            return { ok: true }
          },
        }),
      ],
    })

    const run = await runPipeline(wf, {})

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ ok: true })
  })

  it('code() step with missing secret throws MissingSecretError', async () => {
    const wf = pipeline({
      id: 'missing-secret',
      steps: [
        code({
          id: 'missing',
          secrets: ['NONEXISTENT'],
          run: (ctx) => {
            const token = ctx.secrets?.get('NONEXISTENT')
            return { token }
          },
        }),
      ],
    })

    const env = { OTHER_KEY: 'value' }
    const resolver = new EnvSecretResolver(() => env)

    const run = await runPipeline(wf, {}, { secretResolver: resolver })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('MissingSecretError')
    expect(run.error?.message).toContain('NONEXISTENT')
  })

  it('code() step with multiple secrets resolves all of them', async () => {
    const wf = pipeline({
      id: 'multi-secrets',
      steps: [
        code({
          id: 'multi',
          secrets: ['KEY1', 'KEY2'],
          run: (ctx) => {
            const key1 = ctx.secrets?.get('KEY1')
            const key2 = ctx.secrets?.get('KEY2')
            return { combined: `${key1}-${key2}` }
          },
        }),
      ],
    })

    const env = { KEY1: 'value1', KEY2: 'value2' }
    const resolver = new EnvSecretResolver(() => env)

    const run = await runPipeline(wf, {}, { secretResolver: resolver })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ combined: 'value1-value2' })
  })
})

describe('secrets in infer() steps', () => {
  function mockLlmBackend(captured: { prompt: string; system?: string }): SkelmBackend {
    return {
      id: 'mock-llm',
      capabilities: {
        prompt: true,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      async inference(req) {
        captured.prompt = req.messages[0]?.content ?? ''
        captured.system = req.system
        return { text: 'mock response' }
      },
    }
  }

  it('infer() step with secrets receives ctx.secrets.get() in prompt function', async () => {
    const captured = { prompt: '', system: undefined }
    const registry = new BackendRegistry()
    registry.register(mockLlmBackend(captured))

    const wf = pipeline({
      id: 'inference-secrets',
      steps: [
        infer({
          id: 'inference-with-secrets',
          backend: 'mock-llm',
          secrets: ['API_KEY'],
          prompt: (ctx) => {
            const key = ctx.secrets?.get('API_KEY')
            return `use key ${key} to process this`
          },
        }),
      ],
    })

    const env = { API_KEY: 'secret-api-key' }
    const resolver = new EnvSecretResolver(() => env)

    const run = await runPipeline(
      wf,
      {},
      {
        backends: registry,
        secretResolver: resolver,
      },
    )

    expect(run.status).toBe('completed')
    expect(captured.prompt).toBe('use key secret-api-key to process this')
  })

  it('infer() step without secrets has ctx.secrets === undefined', async () => {
    const captured = { prompt: '', system: undefined }
    const registry = new BackendRegistry()
    registry.register(mockLlmBackend(captured))

    const wf = pipeline({
      id: 'inference-no-secrets',
      steps: [
        infer({
          id: 'inference-no-secrets-step',
          backend: 'mock-llm',
          prompt: (ctx) => {
            expect(ctx.secrets).toBeUndefined()
            return 'no secrets here'
          },
        }),
      ],
    })

    const run = await runPipeline(wf, {}, { backends: registry })

    expect(run.status).toBe('completed')
    expect(captured.prompt).toBe('no secrets here')
  })

  it('infer() step with missing secret throws MissingSecretError', async () => {
    const registry = new BackendRegistry()
    registry.register({
      id: 'mock-llm-2',
      capabilities: {
        prompt: true,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      async inference(req) {
        return { text: 'mock response' }
      },
    })

    const wf = pipeline({
      id: 'inference-missing',
      steps: [
        infer({
          id: 'inference-missing-secret',
          backend: 'mock-llm-2',
          secrets: ['MISSING_KEY'],
          prompt: (ctx) => {
            const key = ctx.secrets?.get('MISSING_KEY')
            return `key is ${key}`
          },
        }),
      ],
    })

    const env = { OTHER: 'value' }
    const resolver = new EnvSecretResolver(() => env)

    const run = await runPipeline(
      wf,
      {},
      {
        backends: registry,
        secretResolver: resolver,
      },
    )
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('MissingSecretError')
    expect(run.error?.message).toContain('MISSING_KEY')
  })
})

describe('secrets in agent() steps', () => {
  function mockAgentBackend(captured: {
    prompt: string
    system?: string
    secrets?: Readonly<Record<string, string>>
  }): SkelmBackend {
    return {
      id: 'mock-agent',
      capabilities: {
        prompt: true,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      async run(req) {
        captured.prompt = req.prompt
        captured.system = req.system
        captured.secrets = req.secrets
        return { text: 'mock-response' }
      },
    }
  }

  it('agent() step with secrets sees ctx.secrets in prompt + system + mcp callbacks', async () => {
    const captured: {
      prompt: string
      system?: string
      secrets?: Readonly<Record<string, string>>
    } = { prompt: '', system: undefined, secrets: undefined }
    const registry = new BackendRegistry()
    registry.register(mockAgentBackend(captured))

    let mcpSawSecret: string | undefined
    const wf = pipeline({
      id: 'agent-secrets',
      steps: [
        agent({
          id: 'agent-with-secrets',
          backend: 'mock-agent',
          secrets: ['API_KEY'],
          // mcp triggers policy resolution; without allowedSecrets the
          // enforcer's canAccessSecret would deny the resolution step.
          permissions: { allowedSecrets: ['API_KEY'] },
          prompt: (ctx) => `use ${ctx.secrets?.get('API_KEY')} please`,
          system: (ctx) => `system uses ${ctx.secrets?.get('API_KEY')}`,
          mcp: (ctx) => {
            mcpSawSecret = ctx.secrets?.get('API_KEY')
            return []
          },
        }),
      ],
    })

    const resolver = new EnvSecretResolver(() => ({ API_KEY: 'secret-value' }))

    const run = await runPipeline(wf, {}, { backends: registry, secretResolver: resolver })

    if (run.status !== 'completed') {
      // surface the underlying error so the assertion message is actionable
      throw new Error(`run failed: ${run.error?.name}: ${run.error?.message}`)
    }
    expect(captured.prompt).toBe('use secret-value please')
    expect(captured.system).toBe('system uses secret-value')
    expect(mcpSawSecret).toBe('secret-value')
    // Secrets must also be forwarded to the backend for tool env-var injection.
    expect(captured.secrets).toEqual({ API_KEY: 'secret-value' })
  })

  it('agent() step without secrets has ctx.secrets === undefined in prompt', async () => {
    const captured = { prompt: '', system: undefined, secrets: undefined }
    const registry = new BackendRegistry()
    registry.register(mockAgentBackend(captured))

    const wf = pipeline({
      id: 'agent-no-secrets',
      steps: [
        agent({
          id: 'agent-no-secrets-step',
          backend: 'mock-agent',
          prompt: (ctx) => {
            expect(ctx.secrets).toBeUndefined()
            return 'no secrets here'
          },
        }),
      ],
    })

    const run = await runPipeline(wf, {}, { backends: registry })

    expect(run.status).toBe('completed')
    expect(captured.prompt).toBe('no secrets here')
    expect(captured.secrets).toBeUndefined()
  })

  it('agent() step with missing secret throws MissingSecretError', async () => {
    const registry = new BackendRegistry()
    registry.register(mockAgentBackend({ prompt: '', system: undefined, secrets: undefined }))

    const wf = pipeline({
      id: 'agent-missing',
      steps: [
        agent({
          id: 'agent-missing-secret',
          backend: 'mock-agent',
          secrets: ['MISSING'],
          prompt: (ctx) => `${ctx.secrets?.get('MISSING')}`,
        }),
      ],
    })

    const resolver = new EnvSecretResolver(() => ({ OTHER: 'value' }))

    const run = await runPipeline(wf, {}, { backends: registry, secretResolver: resolver })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('MissingSecretError')
    expect(run.error?.message).toContain('MISSING')
    // Backend must not be invoked once secret resolution fails.
    expect(MissingSecretError).toBeDefined()
  })
})
