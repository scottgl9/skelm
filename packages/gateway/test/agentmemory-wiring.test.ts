import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG, EnvSecretResolver, type SkelmConfig } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Gateway } from '../src/index.js'

// Real gateway, no mocking of enforcement: exercises the agentmemory client
// wiring, the per-step handle factory, secret resolution, and the startup
// health log through the genuine code path.

let stateDir: string

function baseConfig(agentmemory?: SkelmConfig['agentmemory']): SkelmConfig {
  const server = DEFAULT_CONFIG.server ?? {}
  return {
    ...DEFAULT_CONFIG,
    server: { ...server, port: 0, proxy: { ...(server.proxy ?? {}), port: 0 } },
    ...(agentmemory !== undefined ? { agentmemory } : {}),
  }
}

function healthyFetch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-gw-am-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(stateDir, { recursive: true, force: true })
})

describe('gateway agentmemory wiring', () => {
  it('wires a client, exposes a handle factory, and logs when healthy', async () => {
    healthyFetch()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const gw = new Gateway({
      stateDir,
      enableHttp: false,
      config: baseConfig({ enabled: true, url: 'http://memory.invalid:3111', timeoutMs: 50 }),
    })
    await gw.start()
    try {
      expect(gw.agentmemoryEnabled).toBe(true)
      expect(gw.agentmemoryRunOptions().agentmemoryHandleFactory).toBeTypeOf('function')
      await vi.waitFor(() =>
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('agentmemory client wired')),
      )
    } finally {
      await gw.stop()
    }
  })

  it('resolves secretName through the gateway SecretResolver and sends it as a Bearer token', async () => {
    vi.stubEnv('AGENTMEMORY_TEST_SECRET', 'tok-123')
    const fetchSpy = healthyFetch()
    const gw = new Gateway({
      stateDir,
      enableHttp: false,
      secretResolver: new EnvSecretResolver(),
      config: baseConfig({
        enabled: true,
        url: 'http://memory.invalid:3111',
        secretName: 'AGENTMEMORY_TEST_SECRET',
        timeoutMs: 50,
      }),
    })
    await gw.start()
    try {
      const factory = gw.agentmemoryRunOptions().agentmemoryHandleFactory
      expect(factory).toBeTypeOf('function')
      const handle = factory?.({
        runId: 'r',
        stepId: 's',
        canUseAgentmemory: () => ({ allow: true }),
      })
      await handle?.observe({ sessionId: 's', hookType: 'post_tool_use', data: {} })
      const observeCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/observe'))
      const headers = (observeCall?.[1] as RequestInit | undefined)?.headers as
        | Record<string, string>
        | undefined
      expect(headers?.Authorization).toBe('Bearer tok-123')
    } finally {
      await gw.stop()
    }
  })

  it('is inert when agentmemory is disabled', async () => {
    const gw = new Gateway({ stateDir, enableHttp: false, config: baseConfig() })
    await gw.start()
    try {
      expect(gw.agentmemoryEnabled).toBe(false)
      expect(gw.agentmemoryRunOptions()).toEqual({})
    } finally {
      await gw.stop()
    }
  })
})
