import { describe, expect, it, vi } from 'vitest'

import {
  AgentSession,
  type InferDispatch,
  type SessionEvent,
  type SessionMessage,
} from '../../src/index.js'

const echoDispatch: InferDispatch = async ({ messages }) => {
  const last = messages[messages.length - 1]
  return {
    message: {
      role: 'assistant',
      content: `echo: ${last?.content ?? ''}`,
      usage: { inputTokens: 1, outputTokens: 2 },
    },
    stopReason: 'stop',
  }
}

describe('AgentSession', () => {
  it('appends user + assistant messages on prompt()', async () => {
    const s = new AgentSession(echoDispatch)
    const r = await s.prompt('hello')
    expect(r.text).toBe('echo: hello')
    expect(r.stopReason).toBe('stop')
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 2 })
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(s.messages[1]?.content).toBe('echo: hello')
  })

  it('preserves history across multiple prompts', async () => {
    const seen: SessionMessage[][] = []
    const dispatch: InferDispatch = async ({ messages }) => {
      seen.push([...messages])
      return { message: { role: 'assistant', content: 'ok' }, stopReason: 'stop' }
    }
    const s = new AgentSession(dispatch)
    await s.prompt('one')
    await s.prompt('two')

    expect(seen).toHaveLength(2)
    expect(seen[0]?.map((m) => m.role)).toEqual(['user'])
    expect(seen[1]?.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('prepends systemPrompt to the dispatched history', async () => {
    let captured: readonly SessionMessage[] | undefined
    const dispatch: InferDispatch = async ({ messages }) => {
      captured = messages
      return { message: { role: 'assistant', content: 'ok' }, stopReason: 'stop' }
    }
    const s = new AgentSession(dispatch, { systemPrompt: 'be terse' })
    await s.prompt('hi')
    expect(captured?.[0]?.role).toBe('system')
    expect(captured?.[0]?.content).toBe('be terse')
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('emits message_complete + agent_end on a successful prompt', async () => {
    const events: SessionEvent[] = []
    const s = new AgentSession(echoDispatch)
    s.subscribe((e) => events.push(e))
    await s.prompt('hi')

    const types = events.map((e) => e.type)
    expect(types).toEqual(['message_complete', 'message_complete', 'agent_end'])
  })

  it('does NOT emit message_delta unless streamDeltas: true', async () => {
    const seen: string[] = []
    const dispatch: InferDispatch = async ({ onDelta }) => {
      onDelta?.('a')
      onDelta?.('b')
      return { message: { role: 'assistant', content: 'ab' }, stopReason: 'stop' }
    }
    const s = new AgentSession(dispatch)
    s.subscribe((e) => {
      if (e.type === 'message_delta') seen.push(e.text)
    })
    await s.prompt('go')
    expect(seen).toEqual([])
  })

  it('emits message_delta when streamDeltas: true', async () => {
    const seen: string[] = []
    const dispatch: InferDispatch = async ({ onDelta }) => {
      onDelta?.('a')
      onDelta?.('b')
      return { message: { role: 'assistant', content: 'ab' }, stopReason: 'stop' }
    }
    const s = new AgentSession(dispatch)
    s.subscribe((e) => {
      if (e.type === 'message_delta') seen.push(e.text)
    })
    await s.prompt('go', { streamDeltas: true })
    expect(seen).toEqual(['a', 'b'])
  })

  it('subscribe returns an unsubscribe that removes the listener', async () => {
    const s = new AgentSession(echoDispatch)
    const fn = vi.fn()
    const off = s.subscribe(fn)
    await s.prompt('a')
    off()
    await s.prompt('b')
    // Only events from the first prompt: 2 message_complete + 1 agent_end
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('listener exceptions do not abort the prompt', async () => {
    const s = new AgentSession(echoDispatch)
    s.subscribe(() => {
      throw new Error('boom')
    })
    await expect(s.prompt('x')).resolves.toBeDefined()
  })

  it('abort() cancels an in-flight dispatch via signal', async () => {
    let abortedSignal = false
    const dispatch: InferDispatch = async ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          abortedSignal = true
          reject(new Error('aborted'))
        })
      })
    const s = new AgentSession(dispatch)
    const p = s.prompt('hang')
    await s.abort()
    await expect(p).rejects.toThrow(/aborted/)
    expect(abortedSignal).toBe(true)
  })

  it('external AbortSignal cancels the dispatch', async () => {
    const dispatch: InferDispatch = async ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const ac = new AbortController()
    const s = new AgentSession(dispatch)
    const p = s.prompt('hang', { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toThrow()
  })

  it('throws on prompt() after dispose()', async () => {
    const s = new AgentSession(echoDispatch)
    s.dispose()
    await expect(s.prompt('x')).rejects.toThrow(/disposed/)
  })

  it('toJSON / fromJSON round-trips the history and metadata', async () => {
    const s = new AgentSession(echoDispatch, {
      systemPrompt: 'sys',
      metadata: { runId: 'r1' },
      tokenBudget: 8_000,
    })
    await s.prompt('hi')
    const json = s.toJSON()
    expect(json.version).toBe(1)
    expect(json.systemPrompt).toBe('sys')
    expect(json.metadata).toEqual({ runId: 'r1' })
    expect(json.tokenBudget).toBe(8_000)
    expect(json.messages).toHaveLength(2)

    const restored = AgentSession.fromJSON(json, echoDispatch)
    expect(restored.messages).toEqual(json.messages)
    expect(restored.systemPrompt).toBe('sys')
    expect(restored.tokenBudget).toBe(8_000)

    // Continues the conversation after restore.
    await restored.prompt('again')
    expect(restored.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('fromJSON rejects unknown versions', () => {
    expect(() =>
      AgentSession.fromJSON({ version: 99, messages: [] } as never, echoDispatch),
    ).toThrow(/version/)
  })

  it('does not double up system messages when history already starts with one (post-compaction)', async () => {
    let captured: readonly SessionMessage[] | undefined
    const dispatch: InferDispatch = async ({ messages }) => {
      captured = messages
      return { message: { role: 'assistant', content: 'ok' }, stopReason: 'stop' }
    }
    const s = new AgentSession(dispatch, { systemPrompt: 'be terse' })
    s.setMessages([
      { role: 'system', content: 'Earlier conversation summary: ...' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
    await s.prompt('next')
    const roles = captured?.map((m) => m.role) ?? []
    const systemCount = roles.filter((r) => r === 'system').length
    expect(systemCount).toBe(1)
    expect(captured?.[0]?.content).toContain('Earlier conversation summary')
  })

  it('setMessages() replaces history (used by compaction)', () => {
    const s = new AgentSession(echoDispatch)
    const replaced: SessionMessage[] = [
      { role: 'system', content: 'condensed' },
      { role: 'user', content: 'continue' },
    ]
    s.setMessages(replaced)
    expect(s.messages).toEqual(replaced)
  })
})
