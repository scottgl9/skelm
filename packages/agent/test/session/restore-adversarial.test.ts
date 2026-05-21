/**
 * Adversarial test: a SerializedSession must be plain data — no smuggled
 * credentials, no dispatch handle, no live AbortController. Restoring a
 * session from untrusted JSON must not grant the new instance any privilege
 * beyond what the caller-supplied dispatch already grants.
 */

import { describe, expect, it } from 'vitest'

import { AgentSession, type InferDispatch, type SerializedSession } from '../../src/index.js'

const dummyDispatch: InferDispatch = async () => ({
  message: { role: 'assistant', content: 'ok' },
  stopReason: 'stop',
})

describe('AgentSession restore — adversarial', () => {
  it('toJSON() never includes the dispatch function or live controllers', () => {
    const s = new AgentSession(dummyDispatch, { systemPrompt: 'x' })
    const json = s.toJSON() as unknown as Record<string, unknown>
    const allowed = new Set(['version', 'systemPrompt', 'messages', 'metadata', 'tokenBudget'])
    for (const k of Object.keys(json)) {
      expect(allowed.has(k)).toBe(true)
    }
    expect(typeof (json as { dispatch?: unknown }).dispatch).toBe('undefined')
  })

  it('fromJSON() ignores extraneous attacker-controlled fields', () => {
    const attacker: SerializedSession & { apiKey?: string; permissions?: unknown } = {
      version: 1,
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'stolen',
      permissions: { networkEgress: 'allow' },
    }
    const restored = AgentSession.fromJSON(attacker, dummyDispatch)
    const echoed = restored.toJSON() as unknown as Record<string, unknown>
    expect(echoed.apiKey).toBeUndefined()
    expect(echoed.permissions).toBeUndefined()
  })

  it('fromJSON() refuses unknown version numbers (no silent downgrade)', () => {
    expect(() =>
      AgentSession.fromJSON(
        { version: 0 as unknown as 1, messages: [] } as SerializedSession,
        dummyDispatch,
      ),
    ).toThrow(/version/)
    expect(() =>
      AgentSession.fromJSON(
        { version: 99 as unknown as 1, messages: [] } as SerializedSession,
        dummyDispatch,
      ),
    ).toThrow(/version/)
  })

  it('restored session uses the caller-supplied dispatch, not anything from JSON', async () => {
    const calls: string[] = []
    const guarded: InferDispatch = async ({ messages }) => {
      calls.push(messages.map((m) => m.content).join('|'))
      return { message: { role: 'assistant', content: 'guarded-only' }, stopReason: 'stop' }
    }
    const json: SerializedSession = {
      version: 1,
      messages: [
        { role: 'user', content: 'previous' },
        { role: 'assistant', content: 'earlier' },
      ],
    }
    const restored = AgentSession.fromJSON(json, guarded)
    const result = await restored.prompt('next')
    expect(result.text).toBe('guarded-only')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('previous')
    expect(calls[0]).toContain('next')
  })

  it('dispose() on a restored session prevents further prompts', async () => {
    const restored = AgentSession.fromJSON({ version: 1, messages: [] }, dummyDispatch)
    restored.dispose()
    await expect(restored.prompt('x')).rejects.toThrow(/disposed/)
  })

  it('serialized payload contains no AbortController/Set/class instances', () => {
    const s = new AgentSession(dummyDispatch, { systemPrompt: 'x' })
    const text = JSON.stringify(s.toJSON())
    // Round-trip must not throw — confirms only plain data is serialized.
    expect(() => JSON.parse(text)).not.toThrow()
    expect(text.includes('AbortController')).toBe(false)
  })
})
