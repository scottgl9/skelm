import { describe, expect, it, vi } from 'vitest'

import { chatCompletion, chatCompletionsUrl } from '../../src/openai/chat-client.js'

function chatResponse(content = 'ok'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('OpenAI-compatible chat client', () => {
  it('builds chat completion URLs from host roots and /v1 bases', () => {
    expect(chatCompletionsUrl('http://localhost:11434')).toBe(
      'http://localhost:11434/v1/chat/completions',
    )
    expect(chatCompletionsUrl('http://localhost:11434/v1')).toBe(
      'http://localhost:11434/v1/chat/completions',
    )
    expect(chatCompletionsUrl('https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    )
    expect(chatCompletionsUrl('https://example.test/openai/v1/chat/completions')).toBe(
      'https://example.test/openai/v1/chat/completions',
    )
  })

  it('merges custom headers and keeps explicit apiKey authoritative', async () => {
    const fetchSpy = vi.fn(async () => chatResponse())

    await chatCompletion('https://openrouter.ai/api/v1', {
      apiKey: 'key-from-option',
      model: 'openai/gpt-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      headers: {
        Authorization: 'Bearer custom',
        'HTTP-Referer': 'https://skelm.dev',
        'X-OpenRouter-Title': 'skelm',
      },
      fetch: fetchSpy as typeof fetch,
    })

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions')
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer key-from-option',
      'HTTP-Referer': 'https://skelm.dev',
      'X-OpenRouter-Title': 'skelm',
    })
  })
})
