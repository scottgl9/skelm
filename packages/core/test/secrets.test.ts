import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from '../src/backend.js'
import { code, llm, pipeline } from '../src/builders.js'
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

describe('secrets in llm() steps', () => {
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
      async infer(req) {
        captured.prompt = req.messages[0]?.content ?? ''
        captured.system = req.system
        return { text: 'mock response' }
      },
    }
  }

  it('llm() step with secrets receives ctx.secrets.get() in prompt function', async () => {
    const captured = { prompt: '', system: undefined }
    const registry = new BackendRegistry()
    registry.register(mockLlmBackend(captured))

    const wf = pipeline({
      id: 'llm-secrets',
      steps: [
        llm({
          id: 'llm-with-secrets',
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

  it('llm() step without secrets has ctx.secrets === undefined', async () => {
    const captured = { prompt: '', system: undefined }
    const registry = new BackendRegistry()
    registry.register(mockLlmBackend(captured))

    const wf = pipeline({
      id: 'llm-no-secrets',
      steps: [
        llm({
          id: 'llm-no-secrets-step',
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

  it('llm() step with missing secret throws MissingSecretError', async () => {
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
      async infer(req) {
        return { text: 'mock response' }
      },
    })

    const wf = pipeline({
      id: 'llm-missing',
      steps: [
        llm({
          id: 'llm-missing-secret',
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
