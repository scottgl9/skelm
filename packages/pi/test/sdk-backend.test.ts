import type { BackendContext, ResolvedPolicy, Skill } from '@skelm/core'
import { PermissionDeniedError } from '@skelm/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock PiSdkClient so no real pi process is required. Pass through the
// PiSdkUpstreamError class (and other named exports) from the real module
// so `instanceof PiSdkUpstreamError` checks in classifyPiSdkError see the
// same constructor identity.
vi.mock('../src/sdk-client.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/sdk-client.js')>('../src/sdk-client.js')
  const MockPiSdkClient = vi.fn().mockImplementation(() => ({
    prompt: vi.fn().mockResolvedValue({
      text: 'agent output',
      stopReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  }))
  return { ...actual, PiSdkClient: MockPiSdkClient }
})

import { PiSdkBackendError, createPiSdkBackend, derivePiToolAllowlist } from '../src/sdk-backend.js'
import { PiSdkClient, PiSdkUpstreamError } from '../src/sdk-client.js'

function makeCtx(overrides: Partial<BackendContext> = {}): BackendContext {
  return { signal: new AbortController().signal, ...overrides }
}

function makeSkill(id: string, body: string): Skill {
  return { id, description: `Skill ${id}`, metadata: {}, body, source: `/skills/${id}/SKILL.md` }
}

function makePolicy(overrides: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return {
    allowedTools: { exact: new Set(), prefixes: [], star: false },
    deniedTools: { exact: new Set(), prefixes: [], star: false },
    allowedExecutables: new Set(),
    allowedMcpServers: new Set(),
    allowedSkills: new Set(),
    networkEgress: 'deny',
    fsRead: new Set(),
    fsWrite: new Set(),
    approval: null,
    ...overrides,
  }
}

function lastConstructorArgs() {
  return (PiSdkClient as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
}

describe('createPiSdkBackend', () => {
  beforeEach(() => vi.clearAllMocks())

  it('capabilities.skills is true', () => {
    expect(createPiSdkBackend().capabilities.skills).toBe(true)
  })

  it('capabilities.toolPermissions is native', () => {
    expect(createPiSdkBackend().capabilities.toolPermissions).toBe('native')
  })

  it('capabilities.prompt is true (supports llm() steps)', () => {
    expect(createPiSdkBackend().capabilities.prompt).toBe(true)
  })

  it('exposes an infer() method for llm() steps', () => {
    expect(typeof createPiSdkBackend().infer).toBe('function')
  })

  // --- infer (llm steps) ---

  it('infer returns text when no outputSchema is set', async () => {
    const backend = createPiSdkBackend()
    const ctx = { signal: new AbortController().signal }
    const result = await backend.infer?.({ messages: [{ role: 'user', content: 'hi' }] }, ctx)
    expect(result?.text).toBe('agent output')
    expect(result?.structured).toBeUndefined()
  })

  it('infer disables tools (noTools: all) for pure inference', async () => {
    const backend = createPiSdkBackend()
    const ctx = { signal: new AbortController().signal }
    await backend.infer?.({ messages: [{ role: 'user', content: 'hi' }] }, ctx)
    const args = lastConstructorArgs()
    expect(args?.noTools).toBe('all')
    expect(args?.tools).toEqual([])
  })

  it('infer parses structured JSON when outputSchema is provided', async () => {
    ;(PiSdkClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      prompt: vi.fn().mockResolvedValue({
        text: '```json\n{"answer":"42"}\n```',
        stopReason: 'stop',
      }),
    }))
    const backend = createPiSdkBackend()
    const ctx = { signal: new AbortController().signal }
    const result = await backend.infer?.(
      {
        messages: [{ role: 'user', content: 'q' }],
        outputSchema: {
          // minimal Standard Schema stub — runner validates separately
          '~standard': { validate: (v: unknown) => ({ value: v }) },
        } as never,
      },
      ctx,
    )
    expect(result?.structured).toEqual({ answer: '42' })
    expect(result?.text).toBeUndefined()
  })

  it('returns agent text and usage from PiSdkClient', async () => {
    const backend = createPiSdkBackend()
    const result = await backend.run?.({ prompt: 'hello' }, makeCtx())
    expect(result?.text).toBe('agent output')
    expect(result?.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  // --- system prompt ---

  it('does not set system when req.system and options.systemPrompt are absent', async () => {
    await createPiSdkBackend().run?.({ prompt: 'go' }, makeCtx())
    expect(lastConstructorArgs()?.system).toBeUndefined()
    expect(lastConstructorArgs()?.replaceSystemPrompt).toBeUndefined()
  })

  it('appends req.system to pi prompt by default (replaceSystemPrompt false)', async () => {
    await createPiSdkBackend().run?.({ prompt: 'go', system: 'Be concise.' }, makeCtx())
    const args = lastConstructorArgs()
    expect(args?.system).toContain('Be concise.')
    expect(args?.replaceSystemPrompt).toBeFalsy()
  })

  it('replaces pi base when options.systemPrompt is set', async () => {
    await createPiSdkBackend({ systemPrompt: 'Custom base.' }).run?.({ prompt: 'go' }, makeCtx())
    const args = lastConstructorArgs()
    expect(args?.system).toContain('Custom base.')
    expect(args?.replaceSystemPrompt).toBe(true)
  })

  it('combines options.systemPrompt + req.system + skills in order', async () => {
    const loadSkill = vi.fn(
      async (id: string): Promise<Skill | null> => makeSkill(id, `${id} body.`),
    )
    await createPiSdkBackend({ systemPrompt: 'Base.' }).run?.(
      { prompt: 'go', system: 'Step context.', skills: ['triage'] },
      makeCtx({ loadSkill }),
    )
    const { system } = lastConstructorArgs()
    const baseIdx = system.indexOf('Base.')
    const ctxIdx = system.indexOf('Step context.')
    const skillIdx = system.indexOf('triage body.')
    expect(baseIdx).toBeLessThan(ctxIdx)
    expect(ctxIdx).toBeLessThan(skillIdx)
  })

  // --- skill injection ---

  it('injects skill bodies into the system content (not the user message)', async () => {
    const mockPrompt = vi.fn().mockResolvedValue({ text: 'ok', stopReason: 'stop' })
    ;(PiSdkClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      prompt: mockPrompt,
    }))
    const loadSkill = vi.fn(
      async (id: string): Promise<Skill | null> => makeSkill(id, `Body of ${id}.`),
    )
    await createPiSdkBackend().run?.(
      { prompt: 'do it', skills: ['triage'] },
      makeCtx({ loadSkill }),
    )

    // skill content ends up in constructor system arg, not in the user message
    const constructorSystem: string = lastConstructorArgs()?.system ?? ''
    expect(constructorSystem).toContain('## Skill: triage')
    expect(constructorSystem).toContain('Body of triage.')

    // user message passed to prompt() is just the raw prompt
    const sentUserMsg: string = mockPrompt.mock.calls[0][0]
    expect(sentUserMsg).toBe('do it')
    expect(sentUserMsg).not.toContain('[System:')
  })

  // --- tool allowlist ---

  it('passes tool allowlist when policy is provided', async () => {
    const policy = makePolicy({
      allowedExecutables: new Set(['bash']),
      fsRead: new Set(['/project']),
      networkEgress: 'allow',
    })
    await createPiSdkBackend().run?.({ prompt: 'go', permissions: policy }, makeCtx())
    expect(lastConstructorArgs()?.tools).toContain('bash')
    expect(lastConstructorArgs()?.tools).toContain('read')
  })

  it('passes no tools option when policy is undefined', async () => {
    await createPiSdkBackend().run?.({ prompt: 'go' }, makeCtx())
    expect(lastConstructorArgs()?.tools).toBeUndefined()
  })

  // --- sandbox defaults ---

  it('does not override noExtensions when not set (client default applies)', async () => {
    await createPiSdkBackend().run?.({ prompt: 'go' }, makeCtx())
    // backend passes no noExtensions key — client defaults to true
    expect(lastConstructorArgs()?.noExtensions).toBeUndefined()
  })

  it('forwards noExtensions: false when explicitly opted in', async () => {
    await createPiSdkBackend({ noExtensions: false }).run?.({ prompt: 'go' }, makeCtx())
    expect(lastConstructorArgs()?.noExtensions).toBe(false)
  })

  // --- networkEgress fail-closed (pi-sdk is in-process; HTTP_PROXY is not honored) ---

  it("run() refuses when policy.networkEgress is 'deny'", async () => {
    const backend = createPiSdkBackend()
    const policy = makePolicy({ networkEgress: 'deny' })
    await expect(
      backend.run?.({ prompt: 'go', permissions: policy }, makeCtx({ permissions: policy })),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('run() refuses when policy.networkEgress is allowHosts', async () => {
    const backend = createPiSdkBackend()
    const policy = makePolicy({
      networkEgress: { allowHosts: ['api.openai.com'] },
    })
    await expect(
      backend.run?.({ prompt: 'go', permissions: policy }, makeCtx({ permissions: policy })),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it("infer() refuses when policy.networkEgress is 'deny'", async () => {
    const backend = createPiSdkBackend()
    const policy = makePolicy({ networkEgress: 'deny' })
    await expect(
      backend.infer?.(
        { messages: [{ role: 'user', content: 'hi' }] },
        makeCtx({ permissions: policy }),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it("run() proceeds when policy.networkEgress is 'allow'", async () => {
    const backend = createPiSdkBackend()
    const policy = makePolicy({ networkEgress: 'allow' })
    const result = await backend.run?.(
      { prompt: 'go', permissions: policy },
      makeCtx({ permissions: policy }),
    )
    expect(result?.text).toBe('agent output')
  })

  // ---------------------------------------------------------------------
  // F007: upstream errors must surface as thrown PiSdkBackendError, not as
  // a "completed" step with empty text.
  // ---------------------------------------------------------------------

  it('run() promotes PiSdkUpstreamError to PiSdkBackendError so the runner fails the step', async () => {
    const upstream = new PiSdkUpstreamError(
      'pi inference failed (provider=openai, model=gpt-5.4): 401 Incorrect API key provided.',
      'error',
      '401 Incorrect API key provided.',
    )
    ;(PiSdkClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      prompt: vi.fn().mockRejectedValue(upstream),
    }))
    const backend = createPiSdkBackend()
    let caught: unknown
    try {
      await backend.run?.({ prompt: 'go' }, makeCtx())
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PiSdkBackendError)
    expect((caught as Error).message).toContain('pi SDK agent execution failed')
    expect((caught as Error).message).toContain('401 Incorrect API key provided')
    // Original PiSdkUpstreamError preserved as the .cause for diagnostics.
    expect((caught as PiSdkBackendError).cause).toBe(upstream)
  })

  it('infer() promotes PiSdkUpstreamError to PiSdkBackendError', async () => {
    const upstream = new PiSdkUpstreamError(
      'pi inference failed (provider=openai, model=gpt-5.4): rate-limited',
      'error',
      'rate-limited',
    )
    ;(PiSdkClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      prompt: vi.fn().mockRejectedValue(upstream),
    }))
    const backend = createPiSdkBackend()
    let caught: unknown
    try {
      await backend.infer?.({ messages: [{ role: 'user', content: 'hi' }] }, makeCtx())
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PiSdkBackendError)
    expect((caught as Error).message).toContain('pi SDK inference failed')
    expect((caught as Error).message).toContain('rate-limited')
  })
})

describe('derivePiToolAllowlist', () => {
  it('returns undefined when policy is undefined', () => {
    expect(derivePiToolAllowlist(undefined)).toBeUndefined()
  })

  it('returns empty array when policy grants no permissions', () => {
    expect(derivePiToolAllowlist(makePolicy())).toEqual([])
  })

  it('includes bash when allowedExecutables has bash and networkEgress allows', () => {
    const result = derivePiToolAllowlist(
      makePolicy({ allowedExecutables: new Set(['bash']), networkEgress: 'allow' }),
    )
    expect(result).toContain('bash')
    expect(result).not.toContain('read')
  })

  it('includes bash when allowedExecutables has sh and networkEgress allows', () => {
    expect(
      derivePiToolAllowlist(
        makePolicy({ allowedExecutables: new Set(['sh']), networkEgress: 'allow' }),
      ),
    ).toContain('bash')
  })

  it('drops bash from allowlist when networkEgress is deny', () => {
    const result = derivePiToolAllowlist(
      makePolicy({ allowedExecutables: new Set(['bash']), networkEgress: 'deny' }),
    )
    expect(result).not.toContain('bash')
  })

  it('includes read tools when fsRead is non-empty', () => {
    const result = derivePiToolAllowlist(makePolicy({ fsRead: new Set(['/project']) }))
    expect(result).toContain('read')
    expect(result).toContain('grep')
    expect(result).toContain('find')
    expect(result).toContain('ls')
    expect(result).not.toContain('write')
  })

  it('includes write tools when fsWrite is non-empty', () => {
    const result = derivePiToolAllowlist(makePolicy({ fsWrite: new Set(['/project']) }))
    expect(result).toContain('write')
    expect(result).toContain('edit')
    expect(result).toContain('read')
  })

  it('does not duplicate read tools when both fsRead and fsWrite are set', () => {
    const result = derivePiToolAllowlist(
      makePolicy({ fsRead: new Set(['/project']), fsWrite: new Set(['/project']) }),
    )
    expect(result?.filter((t) => t === 'read').length).toBe(1)
  })

  it('combines bash + read + write tools', () => {
    const result = derivePiToolAllowlist(
      makePolicy({
        allowedExecutables: new Set(['bash']),
        fsRead: new Set(['/project']),
        fsWrite: new Set(['/project']),
        networkEgress: 'allow',
      }),
    )
    expect(result).toContain('bash')
    expect(result).toContain('read')
    expect(result).toContain('write')
    expect(result).toContain('edit')
  })
})
