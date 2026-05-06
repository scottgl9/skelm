import type { BackendContext, ResolvedPolicy } from '@skelm/core'
import { PermissionDeniedError } from '@skelm/core'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/rpc-client.js', () => {
  const MockPiRpcClient = vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ text: 'ok', stopReason: 'stop' }),
  }))
  return { PiRpcClient: MockPiRpcClient }
})

import { createPiBackend } from '../src/backend.js'

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
    networkEgress: 'deny',
    fsRead: new Set(),
    fsWrite: new Set(),
    approval: null,
    ...overrides,
  }
}

describe('createPiBackend (RPC)', () => {
  it('declares toolPermissions as unsupported', () => {
    expect(createPiBackend().capabilities.toolPermissions).toBe('unsupported')
  })

  it('refuses to run when a permission policy is provided (defense-in-depth)', async () => {
    const backend = createPiBackend()
    await expect(
      backend.run?.({ prompt: 'go', permissions: makePolicy() }, makeCtx()),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('runs when no permission policy is set', async () => {
    const backend = createPiBackend()
    const result = await backend.run?.({ prompt: 'go' }, makeCtx())
    expect(result?.text).toBe('ok')
  })
})
