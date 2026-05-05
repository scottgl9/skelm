import type { BackendContext } from '@skelm/core'
import type { Skill } from '@skelm/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the OpencodeClientWrapper so run() can be exercised without a live process.
vi.mock('../src/client.js', () => {
  const MockWrapper = vi.fn().mockImplementation(() => ({
    prompt: vi.fn().mockResolvedValue({ text: 'done', stopReason: 'end_turn' }),
    cancel: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  }))
  return { OpencodeClientWrapper: MockWrapper }
})

import { createOpencodeBackend } from '../src/backend.js'
import { OpencodeClientWrapper } from '../src/client.js'

function makeCtx(overrides: Partial<BackendContext> = {}): BackendContext {
  return { signal: new AbortController().signal, ...overrides }
}

function makeSkill(id: string, body: string): Skill {
  return { id, description: `Skill ${id}`, metadata: {}, body, source: `/skills/${id}/SKILL.md` }
}

describe('opencode backend — skill injection via injectSkills', () => {
  let mockPrompt: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrompt = vi.fn().mockResolvedValue({ text: 'done', stopReason: 'end_turn' })
    ;(OpencodeClientWrapper as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      prompt: mockPrompt,
      cancel: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    }))
  })

  it('injects skill bodies into the system prompt before forwarding', async () => {
    const backend = createOpencodeBackend({})
    const loadSkill = vi.fn(
      async (id: string): Promise<Skill | null> => makeSkill(id, `Body of ${id}.`),
    )
    const ctx = makeCtx({ loadSkill })

    await backend.run?.({ prompt: 'go', skills: ['triage'] }, ctx)

    const forwarded = mockPrompt.mock.calls[0][0]
    expect(forwarded.system).toContain('## Skill: triage')
    expect(forwarded.system).toContain('Body of triage.')
    expect(loadSkill).toHaveBeenCalledWith('triage')
  })

  it('appends skills after the step system prompt', async () => {
    const backend = createOpencodeBackend({})
    const loadSkill = vi.fn(
      async (_id: string): Promise<Skill | null> => makeSkill('triage', 'Triage body.'),
    )
    const ctx = makeCtx({ loadSkill })

    await backend.run?.({ prompt: 'go', system: 'You are helpful.', skills: ['triage'] }, ctx)

    const forwarded = mockPrompt.mock.calls[0][0]
    expect(forwarded.system).toMatch(/You are helpful\..*## Skill: triage/s)
  })

  it('skips null skills (denied or unknown)', async () => {
    const backend = createOpencodeBackend({})
    const loadSkill = vi.fn(async (_id: string): Promise<Skill | null> => null)
    const ctx = makeCtx({ loadSkill })

    await backend.run?.({ prompt: 'go', skills: ['denied'] }, ctx)

    const forwarded = mockPrompt.mock.calls[0][0]
    expect(forwarded.system).toBeUndefined()
  })

  it('does not call loadSkill when ctx.loadSkill is absent', async () => {
    const backend = createOpencodeBackend({})

    await backend.run?.({ prompt: 'go', skills: ['triage'] }, makeCtx())

    const forwarded = mockPrompt.mock.calls[0][0]
    expect(forwarded.system).toBeUndefined()
  })
})
