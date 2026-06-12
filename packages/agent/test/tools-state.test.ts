import { TrustEnforcer, resolvePermissions } from '@skelm/core/permissions'
import { describe, expect, it, vi } from 'vitest'

import { type ArtifactHandle, STATE_TOOLS, type StateHandle } from '../src/index.js'
import { BUILTIN_TOOLS, type ToolExecutionContext, builtinToolsForContext } from '../src/tools.js'

// State / artifact tools are contract-defined and gated on the presence of
// their handle. BackendContext does not yet expose these handles, so by default
// they are not advertised and refuse with a not-wired message. When a handle is
// wired (forward-compatible path), they read/write through it.

function tool(name: string) {
  const t = STATE_TOOLS.find((x) => x.name === name)
  if (t === undefined) throw new Error(`state tool ${name} not found`)
  return t
}

function baseCtx(extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const policy = resolvePermissions({}, undefined)
  return { cwd: '/tmp', agentDefRoot: '/tmp', enforcer: new TrustEnforcer(policy), ...extra }
}

function fakeState(): StateHandle {
  const store = new Map<string, unknown>([['known', { a: 1 }]])
  return {
    get: vi.fn(async (k: string) => store.get(k)),
    set: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v)
    }),
    keys: vi.fn(async () => [...store.keys()]),
  }
}

function fakeArtifacts(): ArtifactHandle {
  return { put: vi.fn(async () => ({ id: 'art-9' })), list: vi.fn(async () => []) }
}

describe('state / artifact tools — advertisement', () => {
  it('are not part of the always-on BUILTIN_TOOLS', () => {
    for (const t of STATE_TOOLS) {
      expect(BUILTIN_TOOLS.find((b) => b.name === t.name)).toBeUndefined()
    }
  })

  it('are not advertised when no handles are wired', () => {
    const advertised = builtinToolsForContext(baseCtx()).map((t) => t.name)
    for (const t of STATE_TOOLS) expect(advertised).not.toContain(t.name)
  })

  it('advertises only state tools when only the state handle is wired', () => {
    const advertised = builtinToolsForContext(baseCtx({ state: fakeState() })).map((t) => t.name)
    expect(advertised).toContain('state_get')
    expect(advertised).toContain('state_set')
    expect(advertised).not.toContain('artifact_put')
  })
})

describe('state tools — wired handle', () => {
  it('reads an existing key', async () => {
    const ctx = baseCtx({ state: fakeState() })
    const r = await tool('state_get').handler({ key: 'known' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toBe(JSON.stringify({ a: 1 }))
  })

  it('writes a key', async () => {
    const state = fakeState()
    const ctx = baseCtx({ state })
    const r = await tool('state_set').handler({ key: 'k', value: 42 }, ctx)
    expect(r.isError).toBeFalsy()
    expect(state.set).toHaveBeenCalledWith('k', 42)
  })

  it('refuses with a not-wired message when no state handle is present', async () => {
    const r = await tool('state_get').handler({ key: 'k' }, baseCtx())
    expect(r.isError).toBe(true)
    expect(r.content).toContain('not available')
  })
})

describe('artifact tool — wired handle', () => {
  it('persists an artifact and returns its id', async () => {
    const artifacts = fakeArtifacts()
    const ctx = baseCtx({ artifacts })
    const r = await tool('artifact_put').handler({ name: 'log.txt', content: 'hi' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('art-9')
  })

  it('refuses with a not-wired message when no artifact handle is present', async () => {
    const r = await tool('artifact_put').handler({ name: 'x', content: 'y' }, baseCtx())
    expect(r.isError).toBe(true)
    expect(r.content).toContain('not available')
  })
})
