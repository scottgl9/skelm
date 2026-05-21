import { describe, expect, it, vi } from 'vitest'

import {
  AgentSession,
  type InferDispatch,
  type SerializedSession,
  type SessionMessage,
  compact,
  estimateMessagesTokens,
  estimateTokens,
  findCutPoint,
  serializedSize,
  shouldCompact,
} from '../../src/index.js'

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('returns 1 for tiny strings (rounds up)', () => {
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abc')).toBe(1)
  })

  it('scales roughly linearly with length', () => {
    const t1 = estimateTokens('a'.repeat(40))
    const t2 = estimateTokens('a'.repeat(400))
    expect(t2).toBeGreaterThan(t1 * 5)
    expect(t1).toBe(10)
    expect(t2).toBe(100)
  })
})

describe('estimateMessagesTokens', () => {
  it('sums content plus a per-message framing overhead', () => {
    const msgs: SessionMessage[] = [
      { role: 'user', content: 'a'.repeat(40) },
      { role: 'assistant', content: 'b'.repeat(40) },
    ]
    expect(estimateMessagesTokens(msgs)).toBe(10 + 4 + 10 + 4)
  })

  it('includes tool-call name + arguments', () => {
    const msgs: SessionMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'a'.repeat(40), arguments: 'b'.repeat(40) }],
      },
    ]
    expect(estimateMessagesTokens(msgs)).toBe(0 + 4 + 10 + 10)
  })
})

describe('serializedSize', () => {
  it('returns the byte length of the serialized session', () => {
    const ser: SerializedSession = { version: 1, messages: [{ role: 'user', content: 'hi' }] }
    expect(serializedSize(ser)).toBe(Buffer.byteLength(JSON.stringify(ser), 'utf8'))
  })

  it('accepts an AgentSession instance', () => {
    const session = new AgentSession((async () => ({
      message: { role: 'assistant', content: 'ok' },
      stopReason: 'stop',
    })) as InferDispatch)
    expect(serializedSize(session)).toBeGreaterThan(0)
  })
})

describe('shouldCompact', () => {
  const buildSession = (msg: string, count: number) => {
    const messages: SessionMessage[] = Array.from({ length: count }, () => ({
      role: 'user',
      content: msg,
    }))
    return { version: 1 as const, messages }
  }

  it('returns false when usage is well under the threshold', () => {
    const s = buildSession('hi', 2)
    expect(shouldCompact(s, { contextWindow: 32_000 })).toBe(false)
  })

  it('returns true when tokens exceed the default 75% of context window', () => {
    // Token estimate per message = content/4 + 4. For 30000 chars (7504 tokens),
    // a 2-message session is ~15016 tokens — push contextWindow low enough.
    const s = buildSession('a'.repeat(30_000), 2)
    expect(shouldCompact(s, { contextWindow: 8_000 })).toBe(true)
  })

  it('respects an explicit tokenBudget below the context-window threshold', () => {
    const s = buildSession('a'.repeat(4_000), 2)
    expect(shouldCompact(s, { contextWindow: 32_000, tokenBudget: 1_500 })).toBe(true)
    expect(shouldCompact(s, { contextWindow: 32_000, tokenBudget: 5_000 })).toBe(false)
  })

  it('fires on payloadBytes overflow regardless of token estimate', () => {
    const s = buildSession('x'.repeat(10), 2)
    expect(shouldCompact(s, { contextWindow: 32_000, payloadBytes: 10 })).toBe(true)
  })

  it('uses the configured thresholdFraction', () => {
    const s = buildSession('a'.repeat(4_000), 2)
    expect(shouldCompact(s, { contextWindow: 32_000, thresholdFraction: 0.99 })).toBe(false)
    expect(shouldCompact(s, { contextWindow: 32_000, thresholdFraction: 0.01 })).toBe(true)
  })
})

describe('findCutPoint', () => {
  const m = (role: 'system' | 'user' | 'assistant' | 'tool', n: number): SessionMessage => ({
    role,
    content: `${role}${n}`,
  })

  it('returns 0 when the history is no longer than keepRecent', () => {
    const msgs: SessionMessage[] = [m('user', 1), m('assistant', 2)]
    expect(findCutPoint(msgs)).toBe(0)
    expect(findCutPoint(msgs, { keepRecent: 4 })).toBe(0)
  })

  it('returns messages.length - keepRecent when longer', () => {
    const msgs: SessionMessage[] = [
      m('user', 1),
      m('assistant', 2),
      m('user', 3),
      m('assistant', 4),
      m('user', 5),
      m('assistant', 6),
    ]
    expect(findCutPoint(msgs, { keepRecent: 2 })).toBe(4)
    expect(findCutPoint(msgs, { keepRecent: 4 })).toBe(2)
  })

  it('preserveSystem (default) treats a leading system as fixed prefix when measuring the tail', () => {
    // tail (after the system) is 2 messages, keepRecent default 4 → tail is
    // already short enough, no compaction warranted.
    const msgs: SessionMessage[] = [m('system', 0), m('user', 1), m('assistant', 2)]
    expect(findCutPoint(msgs)).toBe(0)
  })

  it('preserveSystem leaves room above the system message when the tail is long enough', () => {
    const msgs: SessionMessage[] = [
      m('system', 0),
      m('user', 1),
      m('assistant', 2),
      m('user', 3),
      m('assistant', 4),
    ]
    // tail = 4 messages, keepRecent = 2, so a cut is warranted at len-keep = 3.
    expect(findCutPoint(msgs, { keepRecent: 2 })).toBe(3)
  })

  it('preserveSystem: false ignores any leading system when computing the cut', () => {
    const msgs: SessionMessage[] = [m('system', 0), m('user', 1), m('assistant', 2)]
    // Without preservation, length 3 > keepRecent 2, so cut at 3 - 2 = 1.
    expect(findCutPoint(msgs, { keepRecent: 2, preserveSystem: false })).toBe(1)
  })

  it('preserveSystem only triggers when messages[0].role === system', () => {
    const msgs: SessionMessage[] = [m('user', 1), m('assistant', 2), m('user', 3)]
    expect(findCutPoint(msgs, { keepRecent: 2, preserveSystem: true })).toBe(1)
  })
})

describe('compact', () => {
  const m = (role: 'user' | 'assistant', n: number): SessionMessage => ({
    role,
    content: `${role}${n}`,
  })

  it('returns the same messages unchanged when no cut is needed', async () => {
    const msgs: SessionMessage[] = [m('user', 1), m('assistant', 2)]
    const summarize = vi.fn().mockResolvedValue('should not be called')
    const out = await compact(msgs, { summarize, keepRecent: 4 })
    expect(out.messages).toEqual(msgs)
    expect(out.collapsedCount).toBe(0)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('replaces the prefix with a single system summary message', async () => {
    const msgs: SessionMessage[] = [
      m('user', 1),
      m('assistant', 2),
      m('user', 3),
      m('assistant', 4),
      m('user', 5),
      m('assistant', 6),
    ]
    const summarize = vi.fn().mockResolvedValue('past conversation')
    const out = await compact(msgs, { summarize, keepRecent: 2 })

    expect(summarize).toHaveBeenCalledOnce()
    expect(out.collapsedCount).toBe(4)
    expect(out.messages).toHaveLength(3)
    expect(out.messages[0]?.role).toBe('system')
    expect(out.messages[0]?.content).toContain('past conversation')
    expect(out.messages.slice(1)).toEqual([m('user', 5), m('assistant', 6)])
  })

  it('reports a non-negative token saving when collapsing a long prefix', async () => {
    const msgs: SessionMessage[] = [
      { role: 'user', content: 'x'.repeat(1000) },
      { role: 'assistant', content: 'y'.repeat(1000) },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'ok' },
    ]
    const summarize = vi.fn().mockResolvedValue('short')
    const out = await compact(msgs, { summarize, keepRecent: 2 })
    expect(out.estimatedTokenSavings).toBeGreaterThan(400)
  })

  it('passes only the prefix slice to summarize', async () => {
    const msgs: SessionMessage[] = [
      m('user', 1),
      m('assistant', 2),
      m('user', 3),
      m('assistant', 4),
    ]
    let received: readonly SessionMessage[] | undefined
    const summarize = vi.fn(async (s: readonly SessionMessage[]) => {
      received = s
      return 's'
    })
    await compact(msgs, { summarize, keepRecent: 2 })
    expect(received?.map((x) => x.content)).toEqual(['user1', 'assistant2'])
  })
})

describe('compact — preserveSystem', () => {
  const m = (role: 'system' | 'user' | 'assistant', content: string): SessionMessage => ({
    role,
    content,
  })

  it('keeps a leading system message verbatim and emits [system, summary, ...suffix]', async () => {
    const msgs: SessionMessage[] = [
      m('system', 'persistent system'),
      m('user', 'q1'),
      m('assistant', 'a1'),
      m('user', 'q2'),
      m('assistant', 'a2'),
    ]
    const summarize = vi.fn().mockResolvedValue('past chatter')
    const out = await compact(msgs, { summarize, keepRecent: 2 })

    expect(out.collapsedCount).toBe(2)
    expect(out.messages).toHaveLength(4)
    expect(out.messages[0]).toEqual(msgs[0])
    expect(out.messages[1]?.role).toBe('system')
    expect(out.messages[1]?.content).toContain('past chatter')
    expect(out.messages.slice(2)).toEqual([m('user', 'q2'), m('assistant', 'a2')])
  })

  it('does not pass the preserved system message to summarize()', async () => {
    const msgs: SessionMessage[] = [
      m('system', 'persistent system'),
      m('user', 'q1'),
      m('assistant', 'a1'),
      m('user', 'q2'),
      m('assistant', 'a2'),
    ]
    let received: readonly SessionMessage[] | undefined
    const summarize = vi.fn(async (s: readonly SessionMessage[]) => {
      received = s
      return 'past chatter'
    })
    await compact(msgs, { summarize, keepRecent: 2 })
    expect(received?.map((x) => x.role)).toEqual(['user', 'assistant'])
    expect(received?.some((x) => x.content === 'persistent system')).toBe(false)
  })

  it('preserveSystem: false includes the system message in the summarized slice', async () => {
    const msgs: SessionMessage[] = [
      m('system', 'persistent system'),
      m('user', 'q1'),
      m('assistant', 'a1'),
      m('user', 'q2'),
      m('assistant', 'a2'),
    ]
    let received: readonly SessionMessage[] | undefined
    const summarize = vi.fn(async (s: readonly SessionMessage[]) => {
      received = s
      return 'all collapsed'
    })
    const out = await compact(msgs, { summarize, keepRecent: 2, preserveSystem: false })
    expect(received?.[0]?.role).toBe('system')
    expect(out.messages[0]?.role).toBe('system')
    expect(out.messages[0]?.content).toContain('all collapsed')
    // No second preserved head — exactly [summary, ...suffix].
    expect(out.messages).toHaveLength(3)
  })

  it('makes no changes when the system-preserved tail is already short enough', async () => {
    const msgs: SessionMessage[] = [m('system', 'persistent'), m('user', 'q'), m('assistant', 'a')]
    const summarize = vi.fn().mockResolvedValue('should not be called')
    const out = await compact(msgs, { summarize, keepRecent: 4 })
    expect(out.messages).toEqual(msgs)
    expect(out.collapsedCount).toBe(0)
    expect(summarize).not.toHaveBeenCalled()
  })
})

describe('compact + AgentSession integration', () => {
  it('a compaction round-trip preserves the most recent turns', async () => {
    const dispatch: InferDispatch = async () => ({
      message: { role: 'assistant', content: 'ok' },
      stopReason: 'stop',
    })
    const session = new AgentSession(dispatch)
    for (let i = 0; i < 5; i++) {
      await session.prompt(`q${i}`)
    }
    expect(session.messages).toHaveLength(10)

    const result = await compact(session.messages, {
      summarize: async () => 'previous chatter',
      keepRecent: 4,
    })
    session.setMessages(result.messages)

    expect(session.messages[0]?.role).toBe('system')
    expect(session.messages[0]?.content).toContain('previous chatter')
    expect(session.messages.slice(1).map((m) => m.content)).toEqual(['q3', 'ok', 'q4', 'ok'])
  })
})
