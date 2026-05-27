import { describe, expect, it } from 'vitest'
import {
  defaultPromptOf,
  defaultReplyOf,
  isPersistentAgent,
  persistentAgent,
} from '../src/persistent-agent.js'

describe('persistentAgent()', () => {
  it('produces a frozen value with the kind discriminator', () => {
    const a = persistentAgent({ id: 'chat', sessionKey: (p: { chatId: string }) => p.chatId })
    expect(a.kind).toBe('persistent-agent')
    expect(isPersistentAgent(a)).toBe(true)
    expect(Object.isFrozen(a)).toBe(true)
  })

  it('is not pipeline-ish (no steps array) — dispatch routes by kind', () => {
    const a = persistentAgent({ id: 'chat', sessionKey: () => 'k' })
    expect((a as { steps?: unknown }).steps).toBeUndefined()
  })

  it('normalizes interval triggers like pipeline() does', () => {
    const a = persistentAgent({
      id: 'chat',
      sessionKey: () => 'k',
      triggers: [{ kind: 'interval', every: '5m' }],
    })
    const t = a.triggers?.[0]
    expect(t?.kind).toBe('interval')
    expect((t as { everyMs?: number }).everyMs).toBe(300_000)
  })

  it('carries queue triggers through unchanged for the gateway to register', () => {
    const a = persistentAgent({
      id: 'chat',
      sessionKey: () => 'k',
      triggers: [{ kind: 'queue', sourceId: 'telegram' }],
    })
    expect(a.triggers?.[0]).toMatchObject({ kind: 'queue', sourceId: 'telegram' })
  })

  it('throws when id is missing', () => {
    // @ts-expect-error intentionally omitting required id
    expect(() => persistentAgent({ sessionKey: () => 'k' })).toThrow(/id is required/)
  })

  it('throws when sessionKey is not a function', () => {
    // @ts-expect-error intentionally wrong sessionKey type
    expect(() => persistentAgent({ id: 'chat', sessionKey: 'nope' })).toThrow(/sessionKey/)
  })

  it('forwards requestUnrestricted on permissions untouched', () => {
    const a = persistentAgent({
      id: 'assistant',
      sessionKey: () => 'k',
      permissions: { requestUnrestricted: true },
    })
    expect(a.permissions?.requestUnrestricted).toBe(true)
  })
})

describe('default prompt/reply helpers', () => {
  it('defaultPromptOf reads payload.text', () => {
    expect(defaultPromptOf({ text: 'hi' })).toBe('hi')
    expect(defaultPromptOf({})).toBe('')
    expect(defaultPromptOf(null)).toBe('')
  })

  it('defaultReplyOf wraps text as { reply }', () => {
    expect(defaultReplyOf('hello')).toEqual({ reply: 'hello' })
  })
})

describe('isPersistentAgent', () => {
  it('rejects non-persistent values', () => {
    expect(isPersistentAgent({ steps: [] })).toBe(false)
    expect(isPersistentAgent(null)).toBe(false)
    expect(isPersistentAgent('persistent-agent')).toBe(false)
  })
})
