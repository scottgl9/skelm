import type { BackendContext, ResolvedPolicy } from '@skelm/core'
import { BackendUnavailableError, PermissionDeniedError } from '@skelm/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let startError: Error | undefined

vi.mock('../src/rpc-client.js', () => {
  const MockPiRpcClient = vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(() =>
        startError === undefined ? Promise.resolve() : Promise.reject(startError),
      ),
      stop: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue({ text: 'ok', stopReason: 'stop' }),
    }
  })
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
  beforeEach(() => {
    startError = undefined
  })

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

  it('maps a missing pi command to BackendUnavailableError', async () => {
    startError = Object.assign(new Error('spawn pi ENOENT'), { code: 'ENOENT' })
    const backend = createPiBackend({ id: 'pi-local' })
    await expect(backend.run?.({ prompt: 'go' }, makeCtx())).rejects.toBeInstanceOf(
      BackendUnavailableError,
    )
  })

  it('runs when only declaredPermissions.networkEgress is set (Pi can rely on the egress proxy)', async () => {
    const backend = createPiBackend()
    const result = await backend.run?.(
      { prompt: 'go', permissions: makePolicy({ networkEgress: 'allow' }) },
      makeCtx({
        permissions: makePolicy({ networkEgress: 'allow' }),
        declaredPermissions: { networkEgress: 'allow' },
      }),
    )
    expect(result?.text).toBe('ok')
  })

  it('refuses when declaredPermissions includes a non-network dimension', async () => {
    const backend = createPiBackend()
    await expect(
      backend.run?.(
        { prompt: 'go', permissions: makePolicy() },
        makeCtx({
          permissions: makePolicy(),
          declaredPermissions: { networkEgress: 'allow', allowedExecutables: ['curl'] },
        }),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })
})
