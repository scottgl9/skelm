/**
 * Manual live verification for OpenRouter against a free model.
 *
 * Run with:
 *   OPENROUTER_API_KEY=... \
 *   pnpm exec vitest run packages/agent/test/live-openrouter.test.ts
 */

import { describe, expect, it } from 'vitest'

import { chatCompletion } from '@skelm/core/openai'

const apiKey = process.env.OPENROUTER_API_KEY
const skipUnlessSet = apiKey === undefined ? describe.skip : describe

skipUnlessSet('OpenRouter live validation', () => {
  it('routes through /api/v1 with attribution headers and a free model', async () => {
    const response = await chatCompletion('https://openrouter.ai/api/v1', {
      apiKey,
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
      headers: {
        'HTTP-Referer': 'https://skelm.dev',
        'X-OpenRouter-Title': 'skelm',
      },
      messages: [
        {
          role: 'user',
          content: 'Reply with exactly: OPENROUTER-LIVE-OK',
        },
      ],
      timeoutMs: 120_000,
    })

    const content = response.choices?.[0]?.message?.content
    const text = typeof content === 'string' ? content : ''
    expect(text).toContain('OPENROUTER-LIVE-OK')
  }, 180_000)
})
