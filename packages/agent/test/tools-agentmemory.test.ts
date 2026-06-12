import type { AgentmemoryHandle } from '@skelm/core'
import { TrustEnforcer, resolvePermissions } from '@skelm/core/permissions'
import { describe, expect, it, vi } from 'vitest'

import { BUILTIN_TOOLS, type ToolExecutionContext } from '../src/tools.js'

// Granted-path success + adversarial denied-path for the agentmemory tools.
// Denial fires when the matching agentmemory op is not granted; the handle is
// never touched on the deny path.

function tool(name: string) {
  const t = BUILTIN_TOOLS.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool ${name} not found`)
  return t
}

function fakeHandle(overrides: Partial<AgentmemoryHandle> = {}): AgentmemoryHandle {
  return {
    startSession: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    observe: vi.fn(async () => {}),
    smartSearch: vi.fn(async () => ({ hits: [] })),
    context: vi.fn(async () => ({ text: '' })),
    save: vi.fn(async () => ({ id: 'mem-1' })),
    recall: vi.fn(async () => ({ hits: [] })),
    sessions: vi.fn(async () => ({ sessions: [] })),
    graphQuery: vi.fn(async () => ({ nodes: [], edges: [] })),
    ...overrides,
  }
}

function ctxFor(
  ops: { allowSearch?: boolean; allowSave?: boolean; allowRecall?: boolean },
  handle?: AgentmemoryHandle,
): ToolExecutionContext {
  const policy = resolvePermissions({ agentmemory: ops }, undefined)
  return {
    cwd: '/tmp',
    agentDefRoot: '/tmp',
    enforcer: new TrustEnforcer(policy),
    agentmemory: handle,
    agentmemorySessionId: 'sess-1',
  }
}

describe('memory_search', () => {
  it('returns hits when the search op is granted', async () => {
    const handle = fakeHandle({
      smartSearch: vi.fn(async () => ({ hits: [{ id: '1', title: 'JWT', content: 'HS256' }] })),
    })
    const ctx = ctxFor({ allowSearch: true }, handle)
    const r = await tool('memory_search').handler({ query: 'tokens', limit: 3 }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('JWT')
    expect(handle.smartSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'tokens', limit: 3, sessionId: 'sess-1' }),
    )
  })

  it('denies and never touches the handle when search is not granted', async () => {
    const handle = fakeHandle()
    const ctx = ctxFor({ allowSearch: false }, handle)
    const r = await tool('memory_search').handler({ query: 'tokens' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Permission denied')
    expect(handle.smartSearch).not.toHaveBeenCalled()
  })
})

describe('memory_save', () => {
  it('saves when the save op is granted', async () => {
    const handle = fakeHandle()
    const ctx = ctxFor({ allowSave: true }, handle)
    const r = await tool('memory_save').handler({ title: 'fact', content: 'body' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(handle.save).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'fact', content: 'body', sessionId: 'sess-1' }),
    )
  })

  it('denies and never touches the handle when save is not granted', async () => {
    const handle = fakeHandle()
    const ctx = ctxFor({ allowSave: false }, handle)
    const r = await tool('memory_save').handler({ title: 'fact', content: 'body' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Permission denied')
    expect(handle.save).not.toHaveBeenCalled()
  })
})

describe('memory_recall', () => {
  it('recalls when the recall op is granted', async () => {
    const handle = fakeHandle({
      recall: vi.fn(async () => ({ hits: [{ id: '9', title: 'past', content: 'x' }] })),
    })
    const ctx = ctxFor({ allowRecall: true }, handle)
    const r = await tool('memory_recall').handler({ limit: 2 }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('past')
  })

  it('denies when recall is not granted', async () => {
    const handle = fakeHandle()
    const ctx = ctxFor({ allowRecall: false }, handle)
    const r = await tool('memory_recall').handler({}, ctx)
    expect(r.isError).toBe(true)
    expect(handle.recall).not.toHaveBeenCalled()
  })
})

describe('agentmemory tools — handle not wired', () => {
  it('reports not-available when the op is granted but no handle is present', async () => {
    const ctx = ctxFor({ allowSearch: true }, undefined)
    const r = await tool('memory_search').handler({ query: 'x' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('not available')
  })
})
