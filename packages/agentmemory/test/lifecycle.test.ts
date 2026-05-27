import type { AgentmemoryHandle } from '@skelm/core'
import { describe, expect, it, vi } from 'vitest'
import {
  deriveSessionId,
  endMemoryTurn,
  extractPromptText,
  recordMemoryTurn,
  startMemoryTurn,
} from '../src/lifecycle.js'

function fakeHandle(overrides: Partial<AgentmemoryHandle> = {}): AgentmemoryHandle {
  return {
    startSession: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    observe: vi.fn(async () => {}),
    smartSearch: vi.fn(async () => ({ hits: [] })),
    context: vi.fn(async () => ({ text: '' })),
    save: vi.fn(async () => ({ id: '' })),
    recall: vi.fn(async () => ({ hits: [] })),
    sessions: vi.fn(async () => ({ sessions: [] })),
    graphQuery: vi.fn(async () => ({ nodes: [], edges: [] })),
    ...overrides,
  }
}

describe('startMemoryTurn', () => {
  it('is a no-op with empty recall when the handle is undefined', async () => {
    const res = await startMemoryTurn(undefined, { sessionId: 'sess', promptText: 'hi' })
    expect(res).toEqual({ sessionId: 'sess', recallPrefix: '' })
  })

  it('opens a session, captures the prompt, searches, and formats a recall prefix', async () => {
    const handle = fakeHandle({
      smartSearch: vi.fn(async () => ({
        hits: [{ id: '1', title: 'JWT', content: 'use HS256' }],
      })),
    })
    const res = await startMemoryTurn(handle, {
      sessionId: 'sess',
      project: '/p',
      cwd: '/p',
      promptText: 'how do we sign tokens',
    })
    expect(handle.startSession).toHaveBeenCalledWith({
      sessionId: 'sess',
      project: '/p',
      cwd: '/p',
    })
    expect(handle.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess',
        hookType: 'user_prompt_submit',
        data: { prompt: 'how do we sign tokens' },
      }),
    )
    expect(handle.smartSearch).toHaveBeenCalledWith({
      query: 'how do we sign tokens',
      limit: 5,
      sessionId: 'sess',
    })
    expect(res.recallPrefix).toContain('<memory>')
    expect(res.recallPrefix).toContain('- JWT: use HS256')
  })

  it('skips observe and search when the prompt is empty', async () => {
    const handle = fakeHandle()
    const res = await startMemoryTurn(handle, { sessionId: 'sess', promptText: '' })
    expect(handle.startSession).toHaveBeenCalledOnce()
    expect(handle.observe).not.toHaveBeenCalled()
    expect(handle.smartSearch).not.toHaveBeenCalled()
    expect(res.recallPrefix).toBe('')
  })

  it('returns an empty prefix when search yields no hits', async () => {
    const handle = fakeHandle()
    const res = await startMemoryTurn(handle, { sessionId: 'sess', promptText: 'q' })
    expect(handle.observe).toHaveBeenCalledOnce()
    expect(res.recallPrefix).toBe('')
  })
})

describe('recordMemoryTurn', () => {
  it('defaults to task_completed and caps the result at 8000 chars', async () => {
    const handle = fakeHandle()
    await recordMemoryTurn(handle, { sessionId: 'sess', resultText: 'x'.repeat(9000) })
    const arg = (handle.observe as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(arg.hookType).toBe('task_completed')
    expect((arg.data as { result: string }).result).toHaveLength(8000)
  })

  it('honors a custom hookType and is a no-op without a handle', async () => {
    const handle = fakeHandle()
    await recordMemoryTurn(handle, { sessionId: 's', resultText: 'r', hookType: 'stop' })
    expect((handle.observe as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].hookType).toBe('stop')
    await expect(
      recordMemoryTurn(undefined, { sessionId: 's', resultText: 'r' }),
    ).resolves.toBeUndefined()
  })
})

describe('endMemoryTurn', () => {
  it('closes the session and swallows rejections', async () => {
    const handle = fakeHandle({
      endSession: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    await expect(endMemoryTurn(handle, 'sess')).resolves.toBeUndefined()
    expect(handle.endSession).toHaveBeenCalledWith({ sessionId: 'sess' })
  })

  it('is a no-op without a handle', async () => {
    await expect(endMemoryTurn(undefined, 'sess')).resolves.toBeUndefined()
  })
})

describe('deriveSessionId', () => {
  it('uses the request sessionId when present', () => {
    expect(deriveSessionId({ sessionId: 'explicit' }, { runId: 'r', stepId: 's' })).toBe('explicit')
  })

  it('falls back to skelm-<run>-<step>', () => {
    expect(deriveSessionId({}, { runId: 'r1', stepId: 'step1' })).toBe('skelm-r1-step1')
  })

  it('synthesizes run and step when both are missing', () => {
    const id = deriveSessionId({}, {})
    expect(id).toMatch(/^skelm-r-[a-z0-9]+-agent$/)
  })
})

describe('extractPromptText', () => {
  it('caps a string prompt at 1024 chars', () => {
    expect(extractPromptText('a'.repeat(2000))).toHaveLength(1024)
  })

  it('filters text parts, joins them, and caps the result', () => {
    expect(
      extractPromptText([
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png', data: 'xxx' },
        { type: 'text', text: 'world' },
      ]),
    ).toBe('hello world')
  })
})
