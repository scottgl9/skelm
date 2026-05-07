import type { BackendContext, ResolvedPolicy } from '@skelm/core'
import { PermissionDeniedError, TrustEnforcer } from '@skelm/core'
import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createVercelAiBackend } from '../src/backend.js'
import { applyPolicyToTools, wrapToolWithPolicy } from '../src/permissions.js'

function makeCtx(overrides: Partial<BackendContext> = {}): BackendContext {
  return { signal: new AbortController().signal, ...overrides }
}

function makePolicy(overrides: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return {
    allowedTools: { exact: new Set(), prefixes: [], star: false },
    deniedTools: { exact: new Set(), prefixes: [], star: false },
    allowedExecutables: new Set(),
    allowedMcpServers: new Set(),
    allowedSkills: new Set(),
    allowedSecrets: new Set(),
    networkEgress: 'allow',
    fsRead: new Set(),
    fsWrite: new Set(),
    approval: null,
    ...overrides,
  }
}

function buildToolset() {
  const fooExec = vi.fn().mockResolvedValue({ ran: 'foo' })
  const barExec = vi.fn().mockResolvedValue({ ran: 'bar' })
  const set = {
    foo: tool({
      description: 'foo',
      inputSchema: z.object({ x: z.string() }),
      execute: fooExec,
    }),
    bar: tool({
      description: 'bar',
      inputSchema: z.object({ y: z.string() }),
      execute: barExec,
    }),
  }
  return { set, fooExec, barExec }
}

describe('applyPolicyToTools — default-deny', () => {
  it('returns empty toolset when policy is undefined (default-deny)', () => {
    const { set } = buildToolset()
    expect(Object.keys(applyPolicyToTools(set, undefined))).toEqual([])
  })

  it('returns empty toolset when allowedTools is empty (explicit deny)', () => {
    const { set } = buildToolset()
    expect(Object.keys(applyPolicyToTools(set, makePolicy()))).toEqual([])
  })
})

describe('applyPolicyToTools — filtering', () => {
  it('keeps only tools whose names are in allowedTools.exact', () => {
    const { set } = buildToolset()
    const policy = makePolicy({
      allowedTools: { exact: new Set(['foo']), prefixes: [], star: false },
    })
    const filtered = applyPolicyToTools(set, policy)
    expect(Object.keys(filtered).sort()).toEqual(['foo'])
  })

  it('removes tools listed in deniedTools even when allowedTools.star is true', () => {
    const { set } = buildToolset()
    const policy = makePolicy({
      allowedTools: { exact: new Set(), prefixes: [], star: true },
      deniedTools: { exact: new Set(['bar']), prefixes: [], star: false },
    })
    const filtered = applyPolicyToTools(set, policy)
    expect(Object.keys(filtered).sort()).toEqual(['foo'])
  })
})

describe('wrapToolWithPolicy — call-time re-check', () => {
  it('returns denial JSON when the tool name is no longer in allowlist at call time', async () => {
    const { set, fooExec } = buildToolset()
    const denyEnforcer = new TrustEnforcer(makePolicy())
    const wrapped = wrapToolWithPolicy('foo', set.foo, denyEnforcer) as {
      execute: (a: unknown, o: unknown) => Promise<unknown>
    }
    const result = await wrapped.execute({ x: 'y' }, {})
    expect(result).toMatchObject({
      __skelmDenied: true,
      tool: 'foo',
      dimension: 'tool',
      reason: 'not-in-allowlist',
    })
    expect(fooExec).not.toHaveBeenCalled()
  })

  it('forwards args to the original execute when allowed', async () => {
    const { set, fooExec } = buildToolset()
    const allowEnforcer = new TrustEnforcer(
      makePolicy({ allowedTools: { exact: new Set(['foo']), prefixes: [], star: false } }),
    )
    const wrapped = wrapToolWithPolicy('foo', set.foo, allowEnforcer) as {
      execute: (a: unknown, o: unknown) => Promise<unknown>
    }
    const result = await wrapped.execute({ x: 'y' }, {})
    expect(result).toEqual({ ran: 'foo' })
    expect(fooExec).toHaveBeenCalledWith({ x: 'y' }, {})
  })
})

describe('createVercelAiBackend — end-to-end tool denial', () => {
  it('the model receives an empty tool record when policy is undefined, even if options.tools is set', async () => {
    let capturedTools: unknown
    const { set } = buildToolset()
    const model = new MockLanguageModelV3({
      doGenerate: async (opts: unknown) => {
        capturedTools = (opts as { tools?: unknown }).tools
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 }, totalTokens: 2 },
          warnings: [],
        }
      },
    })
    const backend = createVercelAiBackend({ model, tools: set })
    await backend.run?.({ prompt: 'hi' }, makeCtx())
    expect(
      capturedTools === undefined || (Array.isArray(capturedTools) && capturedTools.length === 0),
    ).toBe(true)
  })

  it('the model only sees allowedTools entries when policy filters', async () => {
    let capturedToolNames: string[] = []
    const { set } = buildToolset()
    const model = new MockLanguageModelV3({
      doGenerate: async (opts: unknown) => {
        const t = (opts as { tools?: Array<{ name: string }> }).tools ?? []
        capturedToolNames = t.map((x) => x.name)
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 }, totalTokens: 2 },
          warnings: [],
        }
      },
    })
    const backend = createVercelAiBackend({ model, tools: set })
    const policy = makePolicy({
      allowedTools: { exact: new Set(['foo']), prefixes: [], star: false },
    })
    await backend.run?.({ prompt: 'hi', permissions: policy }, makeCtx({ permissions: policy }))
    expect(capturedToolNames.sort()).toEqual(['foo'])
  })
})

describe('vercel-ai networkEgress fail-closed', () => {
  it("run() refuses when policy.networkEgress is 'deny'", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'never' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 }, totalTokens: 0 },
        warnings: [],
      }),
    })
    const backend = createVercelAiBackend({ model })
    const policy = makePolicy({ networkEgress: 'deny' })
    await expect(
      backend.run?.({ prompt: 'go', permissions: policy }, makeCtx({ permissions: policy })),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('run() refuses when policy.networkEgress is allowHosts', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'never' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 }, totalTokens: 0 },
        warnings: [],
      }),
    })
    const backend = createVercelAiBackend({ model })
    const policy = makePolicy({ networkEgress: { allowHosts: ['api.openai.com'] } })
    await expect(
      backend.run?.({ prompt: 'go', permissions: policy }, makeCtx({ permissions: policy })),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it("infer() refuses when policy.networkEgress is 'deny'", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'never' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 }, totalTokens: 0 },
        warnings: [],
      }),
    })
    const backend = createVercelAiBackend({ model })
    const policy = makePolicy({ networkEgress: 'deny' })
    await expect(
      backend.infer?.(
        { messages: [{ role: 'user', content: 'hi' }] },
        makeCtx({ permissions: policy }),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it("run() proceeds when policy.networkEgress is 'allow'", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 }, totalTokens: 2 },
        warnings: [],
      }),
    })
    const backend = createVercelAiBackend({ model })
    const policy = makePolicy({ networkEgress: 'allow' })
    const result = await backend.run?.(
      { prompt: 'go', permissions: policy },
      makeCtx({ permissions: policy }),
    )
    expect(result?.text).toBe('ok')
  })
})
