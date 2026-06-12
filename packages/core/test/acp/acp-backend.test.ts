import { describe, expect, it } from 'vitest'
import { createAcpBackend } from '../../src/acp/backend.js'
import type { BackendContext } from '../../src/backend.js'
import { runBackendContract } from '../../src/testing/contract.js'

// Minimal factory that starts/stops the mock ACP agent (same mock as
// acp-client.test.ts) so we can run contract tests against a real process.
function makeFactory() {
  return async () => {
    const backend = createAcpBackend({
      id: 'acp-mock',
      command: 'node',
      args: [new URL('./mock-acp-agent.ts', import.meta.url).pathname],
    })
    return backend
  }
}

describe('acp-backend contract', () => {
  runBackendContract(makeFactory(), {
    name: 'acp-backend',
    skip: ['inference'], // ACP backend only implements run(), not inference()
  })
})

describe('acp-backend — fails closed on nontrivial permissions', () => {
  it('defaults to unsupported tool permissions and exposes advisory only when explicit', async () => {
    const strict = createAcpBackend({
      id: 'acp-strict',
      command: 'node',
      args: [new URL('./mock-acp-agent.ts', import.meta.url).pathname],
    })
    const advisory = createAcpBackend({
      id: 'acp-advisory',
      command: 'node',
      args: [new URL('./mock-acp-agent.ts', import.meta.url).pathname],
      permissionMode: 'advisory',
    })
    expect(strict.capabilities.toolPermissions).toBe('unsupported')
    expect(advisory.capabilities.toolPermissions).toBe('advisory')
    await strict.dispose?.()
    await advisory.dispose?.()
  })

  it('rejects steps that declare allowedTools', async () => {
    const backend = createAcpBackend({
      id: 'acp-fail',
      command: 'node',
      args: [new URL('./mock-acp-agent.ts', import.meta.url).pathname],
    })
    try {
      const ctx: Partial<BackendContext> = {
        signal: AbortSignal.timeout(5_000),
        permissions: {
          allowedTools: { exact: new Set(['gh.list_issues']), prefixes: [], star: false },
          deniedTools: { exact: new Set(), prefixes: [], star: false },
          allowedExecutables: new Set(),
          allowedMcpServers: new Set(),
          allowedSkills: new Set(),
          allowedSecrets: new Set(),
          networkEgress: 'deny' as const,
          fsRead: new Set(),
          fsWrite: new Set(),
          approval: null,
        },
      }
      await expect(backend.run({ prompt: 'test' }, ctx as BackendContext)).rejects.toThrow(
        /ACP backend cannot enforce permission policies/,
      )
    } finally {
      await backend.dispose?.()
    }
  })

  it('rejects steps that declare allowedExecutables', async () => {
    const backend = createAcpBackend({
      id: 'acp-fail',
      command: 'node',
      args: [new URL('./mock-acp-agent.ts', import.meta.url).pathname],
    })
    try {
      const ctx: Partial<BackendContext> = {
        signal: AbortSignal.timeout(5_000),
        permissions: {
          allowedTools: { exact: new Set(), prefixes: [], star: false },
          deniedTools: { exact: new Set(), prefixes: [], star: false },
          allowedExecutables: new Set(['git']),
          allowedMcpServers: new Set(),
          allowedSkills: new Set(),
          allowedSecrets: new Set(),
          networkEgress: 'deny' as const,
          fsRead: new Set(),
          fsWrite: new Set(),
          approval: null,
        },
      }
      await expect(backend.run({ prompt: 'test' }, ctx as BackendContext)).rejects.toThrow(
        /ACP backend cannot enforce permission policies/,
      )
    } finally {
      await backend.dispose?.()
    }
  })

  it('rejects steps that declare networkEgress allow', async () => {
    const backend = createAcpBackend({
      id: 'acp-fail',
      command: 'node',
      args: [new URL('./mock-acp-agent.ts', import.meta.url).pathname],
    })
    try {
      const ctx: Partial<BackendContext> = {
        signal: AbortSignal.timeout(5_000),
        permissions: {
          allowedTools: { exact: new Set(), prefixes: [], star: false },
          deniedTools: { exact: new Set(), prefixes: [], star: false },
          allowedExecutables: new Set(),
          allowedMcpServers: new Set(),
          allowedSkills: new Set(),
          allowedSecrets: new Set(),
          networkEgress: { allowHosts: ['api.github.com'] },
          fsRead: new Set(),
          fsWrite: new Set(),
          approval: null,
        },
      }
      await expect(backend.run({ prompt: 'test' }, ctx as BackendContext)).rejects.toThrow(
        /ACP backend cannot enforce permission policies/,
      )
    } finally {
      await backend.dispose?.()
    }
  })

  it('rejects steps that declare fsRead paths', async () => {
    const backend = createAcpBackend({
      id: 'acp-fail',
      command: 'node',
      args: [new URL('./mock-acp-agent.ts', import.meta.url).pathname],
    })
    try {
      const ctx: Partial<BackendContext> = {
        signal: AbortSignal.timeout(5_000),
        permissions: {
          allowedTools: { exact: new Set(), prefixes: [], star: false },
          deniedTools: { exact: new Set(), prefixes: [], star: false },
          allowedExecutables: new Set(),
          allowedMcpServers: new Set(),
          allowedSkills: new Set(),
          allowedSecrets: new Set(),
          networkEgress: 'deny' as const,
          fsRead: new Set(['./']),
          fsWrite: new Set(),
          approval: null,
        },
      }
      await expect(backend.run({ prompt: 'test' }, ctx as BackendContext)).rejects.toThrow(
        /ACP backend cannot enforce permission policies/,
      )
    } finally {
      await backend.dispose?.()
    }
  })

  it('allows steps with empty / deny-only permissions (trivial policy)', async () => {
    const backend = createAcpBackend({
      id: 'acp-fail',
      command: 'node',
      args: [new URL('./mock-acp-agent.ts', import.meta.url).pathname],
    })
    try {
      const ctx: Partial<BackendContext> = {
        signal: AbortSignal.timeout(5_000),
        permissions: {
          allowedTools: { exact: new Set(), prefixes: [], star: false },
          deniedTools: { exact: new Set(), prefixes: [], star: false },
          allowedExecutables: new Set(),
          allowedMcpServers: new Set(),
          allowedSkills: new Set(),
          allowedSecrets: new Set(),
          networkEgress: 'deny' as const,
          fsRead: new Set(),
          fsWrite: new Set(),
          approval: null,
        },
      }
      const result = await backend.run({ prompt: 'hello' }, ctx as BackendContext)
      expect(result.text).toBe('echo:hello')
      expect(result.stopReason).toBe('end_turn')
    } finally {
      await backend.dispose?.()
    }
  })

  it('allows steps with no permissions (fully open)', async () => {
    const backend = createAcpBackend({
      id: 'acp-fail',
      command: 'node',
      args: [new URL('./mock-acp-agent.ts', import.meta.url).pathname],
    })
    try {
      const ctx: Partial<BackendContext> = {
        signal: AbortSignal.timeout(5_000),
      }
      const result = await backend.run({ prompt: 'hello' }, ctx as BackendContext)
      expect(result.text).toBe('echo:hello')
    } finally {
      await backend.dispose?.()
    }
  })

  it('allows nontrivial permissions in explicit advisory mode', async () => {
    const backend = createAcpBackend({
      id: 'acp-advisory',
      command: 'node',
      args: [new URL('./mock-acp-agent.ts', import.meta.url).pathname],
      permissionMode: 'advisory',
    })
    try {
      const ctx: Partial<BackendContext> = {
        signal: AbortSignal.timeout(5_000),
        permissions: {
          allowedTools: { exact: new Set(['gh.list_issues']), prefixes: [], star: false },
          deniedTools: { exact: new Set(), prefixes: [], star: false },
          allowedExecutables: new Set(),
          allowedMcpServers: new Set(),
          allowedSkills: new Set(),
          allowedSecrets: new Set(),
          networkEgress: 'deny' as const,
          fsRead: new Set(),
          fsWrite: new Set(),
          approval: null,
        },
      }
      const result = await backend.run({ prompt: 'hello' }, ctx as BackendContext)
      expect(result.text).toBe('echo:hello')
    } finally {
      await backend.dispose?.()
    }
  })
})
