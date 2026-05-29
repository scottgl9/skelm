import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackendRegistry, DEFAULT_CONFIG, type SkelmBackend, type SkelmConfig } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Gateway } from '../src/index.js'

// Real gateway, no mocking: exercises absorbBackends (the runtime path that lets
// a project-activation step add backends to a running gateway) and the
// idempotent reinitAgentmemory used after a config-adopting reload.

let stateDir: string

function baseConfig(agentmemory?: SkelmConfig['agentmemory']): SkelmConfig {
  const server = DEFAULT_CONFIG.server ?? {}
  return {
    ...DEFAULT_CONFIG,
    server: { ...server, port: 0, proxy: { ...(server.proxy ?? {}), port: 0 } },
    ...(agentmemory !== undefined ? { agentmemory } : {}),
  }
}

function backend(id: string, text: string): SkelmBackend {
  return {
    id,
    capabilities: {
      prompt: true,
      run: true,
      streaming: false,
      sessionLifecycle: false,
      mcp: false,
      skills: false,
      modelSelection: false,
      toolPermissions: 'native',
    },
    async run() {
      return { text }
    },
  }
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-gw-absorb-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await rm(stateDir, { recursive: true, force: true })
})

describe('Gateway.absorbBackends', () => {
  it('adds new ids and leaves an already-trusted id untouched', async () => {
    const seed = new BackendRegistry()
    const trusted = backend('pi', 'trusted')
    seed.register(trusted)
    const gw = new Gateway({ stateDir, enableHttp: false, config: baseConfig(), backends: seed })
    await gw.start()
    try {
      const incoming = new BackendRegistry()
      incoming.register(backend('pi', 'hijack')) // same id — must NOT replace
      incoming.register(backend('openai', 'new')) // fresh id — must be added
      const result = gw.absorbBackends(incoming)
      expect(result.absorbed).toEqual(['openai'])
      expect(result.skipped).toEqual(['pi'])
      // The trusted 'pi' instance is the original, not the incoming hijacker.
      expect(gw.backends?.resolveForAgent({ backendId: 'pi' })).toBe(trusted)
      expect(gw.backends?.has('openai')).toBe(true)
    } finally {
      await gw.stop()
    }
  })

  it('lazily creates a registry when the gateway booted without one', async () => {
    const gw = new Gateway({ stateDir, enableHttp: false, config: baseConfig() })
    await gw.start()
    try {
      expect(gw.backends).toBeUndefined()
      const incoming = new BackendRegistry()
      incoming.register(backend('pi', 'x'))
      const result = gw.absorbBackends(incoming)
      expect(result.absorbed).toEqual(['pi'])
      expect(gw.backends?.has('pi')).toBe(true)
    } finally {
      await gw.stop()
    }
  })
})

describe('Gateway.reinitAgentmemory', () => {
  it('wires the client after a reload adopts an agentmemory config', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    )
    const gw = new Gateway({ stateDir, enableHttp: false, config: baseConfig() })
    await gw.start()
    try {
      expect(gw.agentmemoryEnabled).toBe(false)
      await gw.reload(
        baseConfig({ enabled: true, url: 'http://memory.invalid:3111', timeoutMs: 50 }),
      )
      // reload swaps config but does not wire agentmemory on its own.
      expect(gw.agentmemoryEnabled).toBe(false)
      await gw.reinitAgentmemory()
      expect(gw.agentmemoryEnabled).toBe(true)
    } finally {
      await gw.stop()
    }
  })

  it('is a no-op when the client is already wired', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    )
    const gw = new Gateway({
      stateDir,
      enableHttp: false,
      config: baseConfig({ enabled: true, url: 'http://memory.invalid:3111', timeoutMs: 50 }),
    })
    await gw.start()
    try {
      expect(gw.agentmemoryEnabled).toBe(true)
      await gw.reinitAgentmemory()
      expect(gw.agentmemoryEnabled).toBe(true)
    } finally {
      await gw.stop()
    }
  })
})
