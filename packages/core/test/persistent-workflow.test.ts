import { describe, expect, it } from 'vitest'
import { code } from '../src/builders.js'
import {
  defaultPromptOf,
  defaultReplyOf,
  isPersistentWorkflow,
  persistentWorkflow,
} from '../src/persistent-workflow.js'

describe('persistentWorkflow()', () => {
  it('produces a frozen value with the kind discriminator', () => {
    const wf = persistentWorkflow({
      id: 'chat',
      agent: { sessionKey: (p: { chatId: string }) => p.chatId },
    })
    expect(wf.kind).toBe('persistent-workflow')
    expect(isPersistentWorkflow(wf)).toBe(true)
    expect(Object.isFrozen(wf)).toBe(true)
    expect(Object.isFrozen(wf.agent)).toBe(true)
  })

  it('carries optional preamble steps and freezes them', () => {
    const wf = persistentWorkflow({
      id: 'chat',
      steps: [code({ id: 'prep', run: () => ({ text: 'x' }) })],
      agent: { sessionKey: () => 'k' },
    })
    expect(wf.steps?.[0]?.id).toBe('prep')
    expect(Object.isFrozen(wf.steps)).toBe(true)
  })

  it('normalizes interval triggers like pipeline() does', () => {
    const wf = persistentWorkflow({
      id: 'chat',
      agent: { sessionKey: () => 'k' },
      triggers: [{ kind: 'interval', every: '5m' }],
    })
    const t = wf.triggers?.[0]
    expect(t?.kind).toBe('interval')
    expect((t as { everyMs?: number }).everyMs).toBe(300_000)
  })

  it('carries queue triggers through unchanged for the gateway to register', () => {
    const wf = persistentWorkflow({
      id: 'chat',
      agent: { sessionKey: () => 'k' },
      triggers: [{ kind: 'queue', sourceId: 'telegram' }],
    })
    expect(wf.triggers?.[0]).toMatchObject({ kind: 'queue', sourceId: 'telegram' })
  })

  it('throws when id is missing', () => {
    // @ts-expect-error intentionally omitting required id
    expect(() => persistentWorkflow({ agent: { sessionKey: () => 'k' } })).toThrow(/id is required/)
  })

  it('throws when agent.sessionKey is not a function', () => {
    // @ts-expect-error intentionally wrong sessionKey type
    expect(() => persistentWorkflow({ id: 'chat', agent: { sessionKey: 'nope' } })).toThrow(
      /sessionKey/,
    )
  })

  it('rejects a preamble step using the reserved terminal id', () => {
    expect(() =>
      persistentWorkflow({
        id: 'chat',
        steps: [code({ id: 'turn', run: () => ({}) })],
        agent: { sessionKey: () => 'k' },
      }),
    ).toThrow(/reserved/)
  })

  it('forwards requestUnrestricted on agent.permissions untouched', () => {
    const wf = persistentWorkflow({
      id: 'assistant',
      agent: { sessionKey: () => 'k', permissions: { requestUnrestricted: true } },
    })
    expect(wf.agent.permissions?.requestUnrestricted).toBe(true)
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

describe('isPersistentWorkflow', () => {
  it('rejects non-persistent values', () => {
    expect(isPersistentWorkflow({ steps: [] })).toBe(false)
    expect(isPersistentWorkflow(null)).toBe(false)
    expect(isPersistentWorkflow('persistent-workflow')).toBe(false)
  })
})
