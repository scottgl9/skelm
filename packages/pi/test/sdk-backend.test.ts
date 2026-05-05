import type { BackendContext, ResolvedPolicy, Skill } from '@skelm/core'
import { describe, expect, it, vi } from 'vitest'

// Mock PiSdkClient so no real pi process is required
vi.mock('../src/sdk-client.js', () => {
  const MockPiSdkClient = vi.fn().mockImplementation(() => ({
    prompt: vi.fn().mockResolvedValue({
      text: 'agent output',
      stopReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  }))
  return { PiSdkClient: MockPiSdkClient }
})

import { createPiSdkBackend, derivePiToolAllowlist } from '../src/sdk-backend.js'
import { PiSdkClient } from '../src/sdk-client.js'

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

describe('createPiSdkBackend', () => {
  it('capabilities.skills is true', () => {
    expect(createPiSdkBackend().capabilities.skills).toBe(true)
  })

  it('capabilities.toolPermissions is native', () => {
    expect(createPiSdkBackend().capabilities.toolPermissions).toBe('native')
  })

  it('returns agent text and usage from PiSdkClient', async () => {
    const backend = createPiSdkBackend()
    const result = await backend.run?.({ prompt: 'hello' }, makeCtx())
    expect(result.text).toBe('agent output')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('injects skill bodies into the prompt', async () => {
    const mockPrompt = vi.fn().mockResolvedValue({ text: 'ok', stopReason: 'stop' })
    ;(PiSdkClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      prompt: mockPrompt,
    }))

    const loadSkill = vi.fn(
      async (id: string): Promise<Skill | null> => makeSkill(id, `Body of ${id}.`),
    )
    const backend = createPiSdkBackend()
    await backend.run?.({ prompt: 'do it', skills: ['triage'] }, makeCtx({ loadSkill }))

    const sentPrompt: string = mockPrompt.mock.calls[0][0]
    expect(sentPrompt).toContain('## Skill: triage')
    expect(sentPrompt).toContain('Body of triage.')
  })

  it('passes tool allowlist when policy is provided', async () => {
    const policy = makePolicy({
      allowedExecutables: new Set(['bash']),
      fsRead: new Set(['/project']),
    })
    const backend = createPiSdkBackend()
    await backend.run?.({ prompt: 'go', permissions: policy }, makeCtx())

    const constructorArgs = (PiSdkClient as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
    expect(constructorArgs?.tools).toContain('bash')
    expect(constructorArgs?.tools).toContain('read')
  })

  it('passes no tools option when policy is undefined', async () => {
    const backend = createPiSdkBackend()
    await backend.run?.({ prompt: 'go' }, makeCtx())

    const constructorArgs = (PiSdkClient as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
    expect(constructorArgs?.tools).toBeUndefined()
  })
})

describe('derivePiToolAllowlist', () => {
  it('returns undefined when policy is undefined', () => {
    expect(derivePiToolAllowlist(undefined)).toBeUndefined()
  })

  it('returns empty array when policy grants no permissions', () => {
    const result = derivePiToolAllowlist(makePolicy())
    expect(result).toEqual([])
  })

  it('includes bash when allowedExecutables has bash', () => {
    const result = derivePiToolAllowlist(makePolicy({ allowedExecutables: new Set(['bash']) }))
    expect(result).toContain('bash')
    expect(result).not.toContain('read')
  })

  it('includes bash when allowedExecutables has sh', () => {
    const result = derivePiToolAllowlist(makePolicy({ allowedExecutables: new Set(['sh']) }))
    expect(result).toContain('bash')
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
    const readCount = result?.filter((t) => t === 'read').length ?? 0
    expect(readCount).toBe(1)
  })

  it('combines bash + read + write tools', () => {
    const result = derivePiToolAllowlist(
      makePolicy({
        allowedExecutables: new Set(['bash']),
        fsRead: new Set(['/project']),
        fsWrite: new Set(['/project']),
      }),
    )
    expect(result).toContain('bash')
    expect(result).toContain('read')
    expect(result).toContain('write')
    expect(result).toContain('edit')
  })
})
