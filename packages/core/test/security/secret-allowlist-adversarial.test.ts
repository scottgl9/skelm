import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from '../../src/backend.js'
import { code, infer, pipeline } from '../../src/builders.js'
import { EnvSecretResolver } from '../../src/enforcement/index.js'
import { type AuditEvent, type AuditWriter, runPipeline } from '../../src/index.js'
import { resolvePermissions } from '../../src/permissions.js'

// Adversarial coverage for the `secret` dimension on code() and infer() steps.
//
// The gate was previously skipped for both kinds (resolveDeclaredSecrets was
// called with policy=undefined), so a declared `allowedSecrets` was ignored and
// a delegated child could read any declared secret — a default-deny breach.
// These tests prove default-deny on OMISSION and explicit-deny on VIOLATION for
// both kinds, that the documented no-policy unconditional path is preserved, and
// that a delegation ceiling caps secret access.

class RecordingAuditWriter implements AuditWriter {
  readonly entries: AuditEvent[] = []
  async write(entry: AuditEvent): Promise<void> {
    this.entries.push(entry)
  }
}

const resolver = () => new EnvSecretResolver(() => ({ ALLOWED: 'a', DENIED: 'd', ANY: 'x' }))

function mockLlmBackend(captured: { prompt: string }): SkelmBackend {
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
      return { text: 'mock' }
    },
  }
}

function deniedSecret(entries: AuditEvent[]): AuditEvent | undefined {
  return entries.find((e) => e.action === 'permission.denied' && e.details?.dimension === 'secret')
}

describe('code() secret allowlist — default-deny', () => {
  it('a declared policy with allowedSecrets omitted denies every declared secret', async () => {
    let callbackRan = false
    const audit = new RecordingAuditWriter()
    const wf = pipeline({
      id: 'code-secret-omission',
      steps: [
        code({
          id: 'use',
          // Policy declared (executable dimension) but allowedSecrets omitted ->
          // default-deny within the policy.
          permissions: { allowedExecutables: ['git'] },
          secrets: ['DENIED'],
          run: (ctx) => {
            callbackRan = true
            return { token: ctx.secrets?.get('DENIED') }
          },
        }),
      ],
    })
    const run = await runPipeline(wf, {}, { secretResolver: resolver(), auditWriter: audit })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(callbackRan).toBe(false)
    expect(deniedSecret(audit.entries)).toBeDefined()
  })
})

describe('code() secret allowlist — explicit-deny', () => {
  it('a secret outside allowedSecrets is denied before the callback runs', async () => {
    let callbackRan = false
    const audit = new RecordingAuditWriter()
    const wf = pipeline({
      id: 'code-secret-violation',
      steps: [
        code({
          id: 'use',
          permissions: { allowedSecrets: ['ALLOWED'] },
          secrets: ['DENIED'],
          run: (ctx) => {
            callbackRan = true
            return { token: ctx.secrets?.get('DENIED') }
          },
        }),
      ],
    })
    const run = await runPipeline(wf, {}, { secretResolver: resolver(), auditWriter: audit })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(callbackRan).toBe(false)
    expect(deniedSecret(audit.entries)).toBeDefined()
  })

  it('a secret inside allowedSecrets reaches the callback', async () => {
    const wf = pipeline({
      id: 'code-secret-allowed',
      steps: [
        code({
          id: 'use',
          permissions: { allowedSecrets: ['ALLOWED'] },
          secrets: ['ALLOWED'],
          run: (ctx) => ({ token: ctx.secrets?.get('ALLOWED') }),
        }),
      ],
    })
    const run = await runPipeline(wf, {}, { secretResolver: resolver() })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ token: 'a' })
  })
})

describe('code() secret allowlist — no policy preserves unconditional access', () => {
  it('a step that declares no permissions resolves declared secrets unconditionally', async () => {
    const wf = pipeline({
      id: 'code-secret-no-policy',
      steps: [
        code({
          id: 'use',
          secrets: ['ANY'],
          run: (ctx) => ({ token: ctx.secrets?.get('ANY') }),
        }),
      ],
    })
    const run = await runPipeline(wf, {}, { secretResolver: resolver() })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ token: 'x' })
  })
})

describe('code() secret allowlist — delegation ceiling caps a child self-grant', () => {
  it('a child cannot read a secret outside the delegating ceiling even if it declares it', async () => {
    const ceiling = resolvePermissions(undefined, { allowedSecrets: ['ALLOWED'] }, {}, {})
    const wf = pipeline({
      id: 'code-secret-ceiling',
      steps: [
        code({
          id: 'use',
          // Child declares DENIED, but the ceiling only permits ALLOWED.
          permissions: { allowedSecrets: ['DENIED'] },
          secrets: ['DENIED'],
          run: (ctx) => ({ token: ctx.secrets?.get('DENIED') }),
        }),
      ],
    })
    const run = await runPipeline(
      wf,
      {},
      { secretResolver: resolver(), delegationCeiling: ceiling },
    )
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
  })
})

describe('infer() secret allowlist — delegation ceiling', () => {
  it('denies a secret outside the delegating ceiling', async () => {
    const registry = new BackendRegistry()
    registry.register(mockLlmBackend({ prompt: '' }))
    const ceiling = resolvePermissions(undefined, { allowedSecrets: ['ALLOWED'] }, {}, {})
    const wf = pipeline({
      id: 'infer-secret-ceiling-deny',
      steps: [
        infer({
          id: 'gen',
          backend: 'mock-llm',
          secrets: ['DENIED'],
          prompt: (ctx) => `key ${ctx.secrets?.get('DENIED')}`,
        }),
      ],
    })
    const audit = new RecordingAuditWriter()
    const run = await runPipeline(
      wf,
      {},
      {
        backends: registry,
        secretResolver: resolver(),
        delegationCeiling: ceiling,
        auditWriter: audit,
      },
    )
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(deniedSecret(audit.entries)).toBeDefined()
  })

  it('allows a secret inside the delegating ceiling', async () => {
    const captured = { prompt: '' }
    const registry = new BackendRegistry()
    registry.register(mockLlmBackend(captured))
    const ceiling = resolvePermissions(undefined, { allowedSecrets: ['ALLOWED'] }, {}, {})
    const wf = pipeline({
      id: 'infer-secret-ceiling-allow',
      steps: [
        infer({
          id: 'gen',
          backend: 'mock-llm',
          secrets: ['ALLOWED'],
          prompt: (ctx) => `key ${ctx.secrets?.get('ALLOWED')}`,
        }),
      ],
    })
    const run = await runPipeline(
      wf,
      {},
      {
        backends: registry,
        secretResolver: resolver(),
        delegationCeiling: ceiling,
      },
    )
    expect(run.status).toBe('completed')
    expect(captured.prompt).toBe('key a')
  })
})

describe('infer() secret allowlist — no ceiling preserves unconditional access', () => {
  it('a top-level infer with no ceiling resolves declared secrets unconditionally', async () => {
    const captured = { prompt: '' }
    const registry = new BackendRegistry()
    registry.register(mockLlmBackend(captured))
    const wf = pipeline({
      id: 'infer-secret-no-ceiling',
      steps: [
        infer({
          id: 'gen',
          backend: 'mock-llm',
          secrets: ['ANY'],
          prompt: (ctx) => `key ${ctx.secrets?.get('ANY')}`,
        }),
      ],
    })
    const run = await runPipeline(wf, {}, { backends: registry, secretResolver: resolver() })
    expect(run.status).toBe('completed')
    expect(captured.prompt).toBe('key x')
  })
})
