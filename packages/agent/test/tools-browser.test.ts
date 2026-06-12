import { TrustEnforcer, resolvePermissions } from '@skelm/core/permissions'
import { describe, expect, it, vi } from 'vitest'

import { BROWSER_TOOLS, type BrowserProvider } from '../src/index.js'
import type { ArtifactHandle } from '../src/index.js'
import { BUILTIN_TOOLS, type ToolExecutionContext, builtinToolsForContext } from '../src/tools.js'

// Browser tools are a CONTRACT: not advertised without a provider, routed
// through the network dimension on navigation, and requiring an artifact sink
// for screenshots. The concrete driver is deferred to @skelm/browser-automation.

function tool(name: string) {
  const t = BROWSER_TOOLS.find((x) => x.name === name)
  if (t === undefined) throw new Error(`browser tool ${name} not found`)
  return t
}

function fakeProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    navigate: vi.fn(async (url: string) => ({ text: 'ok', url })),
    click: vi.fn(async () => ({ text: 'clicked' })),
    type: vi.fn(async () => ({ text: 'typed' })),
    screenshot: vi.fn(async () => ({ data: 'BASE64', contentType: 'image/png' })),
    extract: vi.fn(async () => ({ text: 'extracted' })),
    ...overrides,
  }
}

function fakeArtifacts(): ArtifactHandle {
  return {
    put: vi.fn(async () => ({ id: 'art-1' })),
    list: vi.fn(async () => []),
  }
}

function ctx(opts: {
  network?: 'allow' | 'deny' | { allowHosts: readonly string[] }
  browser?: BrowserProvider
  artifacts?: ArtifactHandle
}): ToolExecutionContext {
  const policy = resolvePermissions({ networkEgress: opts.network ?? 'deny' }, undefined)
  return {
    cwd: '/tmp',
    agentDefRoot: '/tmp',
    enforcer: new TrustEnforcer(policy),
    ...(opts.browser !== undefined && { browser: opts.browser }),
    ...(opts.artifacts !== undefined && { artifacts: opts.artifacts }),
  }
}

describe('browser tools — advertisement', () => {
  it('are not part of the always-on BUILTIN_TOOLS', () => {
    for (const t of BROWSER_TOOLS) {
      expect(BUILTIN_TOOLS.find((b) => b.name === t.name)).toBeUndefined()
    }
  })

  it('are not advertised when no provider is wired', () => {
    const advertised = builtinToolsForContext(ctx({})).map((t) => t.name)
    for (const t of BROWSER_TOOLS) expect(advertised).not.toContain(t.name)
  })

  it('are advertised once a provider is wired', () => {
    const advertised = builtinToolsForContext(ctx({ browser: fakeProvider() })).map((t) => t.name)
    for (const t of BROWSER_TOOLS) expect(advertised).toContain(t.name)
  })

  it('exposes the five-verb contract shape', () => {
    expect(BROWSER_TOOLS.map((t) => t.name).sort()).toEqual([
      'browser_click',
      'browser_extract',
      'browser_navigate',
      'browser_screenshot',
      'browser_type',
    ])
  })
})

describe('browser_navigate — network gate', () => {
  it('navigates when the host is allowed', async () => {
    const provider = fakeProvider()
    const r = await tool('browser_navigate').handler(
      { url: 'https://example.com/page' },
      ctx({ network: { allowHosts: ['example.com'] }, browser: provider }),
    )
    expect(r.isError).toBeFalsy()
    expect(provider.navigate).toHaveBeenCalledWith('https://example.com/page')
  })

  it('denies navigation when the network dimension is not granted', async () => {
    const provider = fakeProvider()
    const r = await tool('browser_navigate').handler(
      { url: 'https://example.com/page' },
      ctx({ network: 'deny', browser: provider }),
    )
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Permission denied')
    expect(provider.navigate).not.toHaveBeenCalled()
  })

  it('refuses when no provider is wired', async () => {
    const r = await tool('browser_navigate').handler(
      { url: 'https://example.com' },
      ctx({ network: 'allow' }),
    )
    expect(r.isError).toBe(true)
    expect(r.content).toContain('no browser provider')
  })
})

describe('browser_screenshot — artifact sink', () => {
  it('persists the screenshot as an artifact when a sink is present', async () => {
    const provider = fakeProvider()
    const artifacts = fakeArtifacts()
    const r = await tool('browser_screenshot').handler({}, ctx({ browser: provider, artifacts }))
    expect(r.isError).toBeFalsy()
    expect(artifacts.put).toHaveBeenCalledWith(
      expect.objectContaining({ encoding: 'base64', content: 'BASE64' }),
    )
    expect(r.content).toContain('art-1')
  })

  it('refuses when no artifact sink is wired', async () => {
    const provider = fakeProvider()
    const r = await tool('browser_screenshot').handler({}, ctx({ browser: provider }))
    expect(r.isError).toBe(true)
    expect(r.content).toContain('artifact sink')
    expect(provider.screenshot).not.toHaveBeenCalled()
  })
})
