import type { BackendContext, Skill } from '@skelm/core'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { createVercelAiBackend } from '../src/backend.js'

function makeSkill(id: string, body: string): Skill {
  return { id, description: `Skill ${id}`, metadata: {}, body, source: `/skills/${id}/SKILL.md` }
}

function captureSystem() {
  const captured: { system?: string; userMsgs: string[] } = { userMsgs: [] }
  const model = new MockLanguageModelV3({
    doGenerate: async (opts: { prompt: Array<{ role: string; content: unknown }> }) => {
      const sys = opts.prompt.find((m) => m.role === 'system')
      captured.system = typeof sys?.content === 'string' ? sys.content : undefined
      for (const m of opts.prompt) {
        if (m.role === 'user') {
          if (typeof m.content === 'string') captured.userMsgs.push(m.content)
          else if (Array.isArray(m.content)) {
            for (const part of m.content as Array<{ type?: string; text?: string }>) {
              if (part.type === 'text' && typeof part.text === 'string')
                captured.userMsgs.push(part.text)
            }
          }
        }
      }
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 }, totalTokens: 2 },
        warnings: [],
      }
    },
  })
  return { model, captured }
}

describe('skill injection', () => {
  it('appends loaded skill bodies to the system prompt (not the user message)', async () => {
    const { model, captured } = captureSystem()
    const loadSkill = vi.fn(
      async (id: string): Promise<Skill | null> => makeSkill(id, `Body of ${id}.`),
    )
    const backend = createVercelAiBackend({ model })
    await backend.run?.({ prompt: 'do it', skills: ['triage'] }, {
      signal: new AbortController().signal,
      loadSkill,
    } as BackendContext)
    expect(captured.system ?? '').toContain('Body of triage.')
    expect(captured.userMsgs.join('\n')).toBe('do it')
    expect(captured.userMsgs.join('\n')).not.toContain('Body of triage.')
  })

  it('silently skips skills when loadSkill returns null (denied)', async () => {
    const { model, captured } = captureSystem()
    const loadSkill = vi.fn(async () => null)
    const backend = createVercelAiBackend({ model })
    await backend.run?.({ prompt: 'go', skills: ['secret-skill'] }, {
      signal: new AbortController().signal,
      loadSkill,
    } as BackendContext)
    expect(captured.system).toBeUndefined()
  })

  it('does not call loadSkill when no skills are requested', async () => {
    const { model } = captureSystem()
    const loadSkill = vi.fn()
    const backend = createVercelAiBackend({ model })
    await backend.run?.({ prompt: 'go' }, {
      signal: new AbortController().signal,
      loadSkill,
    } as BackendContext)
    expect(loadSkill).not.toHaveBeenCalled()
  })
})
