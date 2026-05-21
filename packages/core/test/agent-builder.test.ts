import { describe, expect, it } from 'vitest'

import { agent } from '../src/builders.js'

describe('agent() builder', () => {
  it('forwards systemPromptMode onto the frozen step', () => {
    const step = agent({
      id: 'extractor',
      prompt: '...',
      system: 'Output only JSON.',
      systemPromptMode: 'replace',
    })
    expect(step.systemPromptMode).toBe('replace')
  })

  it('forwards systemPromptIncludeAgentDef onto the frozen step', () => {
    const step = agent({
      id: 'extractor',
      prompt: '...',
      systemPromptMode: 'replace',
      systemPromptIncludeAgentDef: false,
    })
    expect(step.systemPromptIncludeAgentDef).toBe(false)
  })

  it('omits both fields when not provided', () => {
    const step = agent({ id: 'plain', prompt: '...' })
    expect(step.systemPromptMode).toBeUndefined()
    expect(step.systemPromptIncludeAgentDef).toBeUndefined()
  })

  it('accepts systemPromptMode: extend explicitly', () => {
    const step = agent({ id: 'x', prompt: '...', systemPromptMode: 'extend' })
    expect(step.systemPromptMode).toBe('extend')
  })

  it('accepts a multimodal ContentPart[] prompt', () => {
    const step = agent({
      id: 'see',
      prompt: [
        { type: 'text', text: 'describe' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      ],
    })
    expect(Array.isArray(step.prompt)).toBe(true)
  })
})
