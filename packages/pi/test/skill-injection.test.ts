import type { BackendContext, Skill } from '@skelm/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/rpc-client.js', () => {
  const MockPiRpcClient = vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ text: 'done', stopReason: 'end_turn' }),
    abort: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }))
  return { PiRpcClient: MockPiRpcClient }
})

import { createPiBackend } from '../src/backend.js'
import { PiRpcClient } from '../src/rpc-client.js'

function makeCtx(overrides: Partial<BackendContext> = {}): BackendContext {
  return { signal: new AbortController().signal, ...overrides }
}

function makeSkill(id: string, body: string): Skill {
  return { id, description: `Skill ${id}`, metadata: {}, body, source: `/skills/${id}/SKILL.md` }
}

describe('pi backend — skill injection via buildPrompt', () => {
  let mockPrompt: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrompt = vi.fn().mockResolvedValue({ text: 'done', stopReason: 'end_turn' })
    ;(PiRpcClient as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      prompt: mockPrompt,
      abort: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }))
  })

  it('capabilities.skills is true', () => {
    expect(createPiBackend({}).capabilities.skills).toBe(true)
  })

  it('injects skill bodies into the [System:] block', async () => {
    const backend = createPiBackend({})
    const loadSkill = vi.fn(
      async (id: string): Promise<Skill | null> => makeSkill(id, `Body of ${id}.`),
    )
    const ctx = makeCtx({ loadSkill })

    await backend.run!({ prompt: 'do the thing', skills: ['triage'] }, ctx)

    const sentPrompt: string = mockPrompt.mock.calls[0][0]
    expect(sentPrompt).toContain('[System:')
    expect(sentPrompt).toContain('## Skill: triage')
    expect(sentPrompt).toContain('Body of triage.')
    expect(loadSkill).toHaveBeenCalledWith('triage')
  })

  it('appends skills after the step system prompt', async () => {
    const backend = createPiBackend({})
    const loadSkill = vi.fn(
      async (_id: string): Promise<Skill | null> => makeSkill('triage', 'Triage body.'),
    )
    const ctx = makeCtx({ loadSkill })

    await backend.run!({ prompt: 'go', system: 'Be concise.', skills: ['triage'] }, ctx)

    const sentPrompt: string = mockPrompt.mock.calls[0][0]
    expect(sentPrompt).toMatch(/Be concise\..*## Skill: triage/s)
  })

  it('skips null skills (denied or unknown)', async () => {
    const backend = createPiBackend({})
    const loadSkill = vi.fn(async (_id: string): Promise<Skill | null> => null)
    const ctx = makeCtx({ loadSkill })

    await backend.run!({ prompt: 'go', skills: ['denied'] }, ctx)

    const sentPrompt: string = mockPrompt.mock.calls[0][0]
    expect(sentPrompt).not.toContain('[System:')
  })

  it('does not call loadSkill when ctx.loadSkill is absent', async () => {
    const backend = createPiBackend({})

    await backend.run!({ prompt: 'go', skills: ['triage'] }, makeCtx())

    const sentPrompt: string = mockPrompt.mock.calls[0][0]
    expect(sentPrompt).not.toContain('[System:')
  })
})
