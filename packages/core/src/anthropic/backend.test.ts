import { describe, expect, it, vi } from 'vitest'
import type { BackendContext } from '../backend.js'
import type { Skill } from '../skills.js'
import { createAnthropicBackend } from './backend.js'

function makeCtx(overrides: Partial<BackendContext> = {}): BackendContext {
  return {
    signal: new AbortController().signal,
    ...overrides,
  }
}

function makeSkill(id: string, body: string): Skill {
  return { id, description: `Skill ${id}`, metadata: {}, body, source: `/skills/${id}/SKILL.md` }
}

function mockFetch(text: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  }) as unknown as typeof fetch
}

describe('createAnthropicBackend — skill injection', () => {
  it('capabilities.skills is true', () => {
    const backend = createAnthropicBackend({ apiKey: 'test' })
    expect(backend.capabilities.skills).toBe(true)
  })

  it('injects skill body into system prompt when skills are declared', async () => {
    const fetchSpy = mockFetch('result')
    const backend = createAnthropicBackend({ apiKey: 'test-key', fetch: fetchSpy })

    const loadSkill = vi.fn(
      async (id: string): Promise<Skill | null> => makeSkill(id, `Body of ${id}.`),
    )
    const ctx = makeCtx({ loadSkill })

    await backend.run!({ prompt: 'do the thing', skills: ['triage', 'classify'] }, ctx)

    const body = JSON.parse((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
    expect(body.system).toContain('## Skill: triage')
    expect(body.system).toContain('Body of triage.')
    expect(body.system).toContain('## Skill: classify')
    expect(loadSkill).toHaveBeenCalledWith('triage')
    expect(loadSkill).toHaveBeenCalledWith('classify')
  })

  it('appends skills after the step system prompt', async () => {
    const fetchSpy = mockFetch('result')
    const backend = createAnthropicBackend({ apiKey: 'test-key', fetch: fetchSpy })

    const loadSkill = vi.fn(
      async (_id: string): Promise<Skill | null> => makeSkill('triage', 'Triage body.'),
    )
    const ctx = makeCtx({ loadSkill })

    await backend.run!({ prompt: 'go', system: 'You are helpful.', skills: ['triage'] }, ctx)

    const body = JSON.parse((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
    expect(body.system).toMatch(/You are helpful\..*## Skill: triage/s)
  })

  it('skips null skills (denied or unknown)', async () => {
    const fetchSpy = mockFetch('result')
    const backend = createAnthropicBackend({ apiKey: 'test-key', fetch: fetchSpy })

    const loadSkill = vi.fn(async (_id: string): Promise<Skill | null> => null)
    const ctx = makeCtx({ loadSkill })

    await backend.run!({ prompt: 'go', skills: ['denied'] }, ctx)

    const body = JSON.parse((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
    expect(body.system).toBeUndefined()
  })

  it('does not call loadSkill when ctx.loadSkill is absent', async () => {
    const fetchSpy = mockFetch('result')
    const backend = createAnthropicBackend({ apiKey: 'test-key', fetch: fetchSpy })

    await backend.run!({ prompt: 'go', skills: ['triage'] }, makeCtx())

    const body = JSON.parse((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
    expect(body.system).toBeUndefined()
  })

  it('run without skills uses system prompt directly', async () => {
    const fetchSpy = mockFetch('result')
    const backend = createAnthropicBackend({ apiKey: 'test-key', fetch: fetchSpy })

    await backend.run!({ prompt: 'go', system: 'Be concise.' }, makeCtx())

    const body = JSON.parse((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
    expect(body.system).toBe('Be concise.')
  })
})
