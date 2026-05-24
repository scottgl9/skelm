import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-config-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

async function boot(): Promise<{ gw: Gateway; base: string }> {
  return bootGatewayWithRetry((port) => ({
    stateDir,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    runStore: new MemoryRunStore(),
    config: {
      server: { auth: { mode: 'none' }, maxConcurrentRuns: 4 },
      secrets: { driver: 'file', file: '/etc/skelm/secrets.json' },
    },
  }))
}

describe('/v1/config', () => {
  it('GET returns the config with secret file paths redacted', async () => {
    const { gw, base } = await boot()
    try {
      const res = await fetch(`${base}/v1/config`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.server.maxConcurrentRuns).toBe(4)
      expect(body.secrets.file).toBe('[redacted]')
    } finally {
      await gw.stop()
    }
  })

  it('PATCH updates whitelisted server.maxConcurrentRuns', async () => {
    const { gw, base } = await boot()
    try {
      const res = await fetch(`${base}/v1/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 'server.maxConcurrentRuns': 8 }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.updated).toBe(true)
      expect(body.config.server.maxConcurrentRuns).toBe(8)
      expect(gw.getConfig().server?.maxConcurrentRuns).toBe(8)
    } finally {
      await gw.stop()
    }
  })

  it('PATCH rejects non-whitelisted keys', async () => {
    const { gw, base } = await boot()
    try {
      const res = await fetch(`${base}/v1/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 'server.host': '0.0.0.0' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('PATCH rejects invalid values', async () => {
    const { gw, base } = await boot()
    try {
      const res = await fetch(`${base}/v1/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 'server.maxConcurrentRuns': -1 }),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('GET succeeds when config holds live backend instances with non-cloneable functions', async () => {
    // Regression for F020: structuredClone(config) used to throw
    // DataCloneError when `instances[]` carried closures like an
    // `infer` function on a backend factory. sanitize() now JSON
    // round-trips and PATCH no longer clones the entire config.
    const { gw, base } = await bootGatewayWithRetry((port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      runStore: new MemoryRunStore(),
      config: {
        server: { auth: { mode: 'none' }, maxConcurrentRuns: 2 },
        instances: [
          // Live backend instance — `run`/`infer` are closures that
          // structuredClone cannot copy.
          {
            id: 'fake-backend',
            capabilities: { prompt: true, streaming: false },
            async run() {
              return { text: 'ok', stopReason: 'stop' }
            },
            async infer() {
              return { text: 'ok' }
            },
          } as unknown as never,
        ],
      },
    }))
    try {
      const getRes = await fetch(`${base}/v1/config`)
      expect(getRes.status).toBe(200)
      const getBody = await getRes.json()
      expect(getBody.server.maxConcurrentRuns).toBe(2)

      const patchRes = await fetch(`${base}/v1/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 'server.maxConcurrentRuns': 5 }),
      })
      expect(patchRes.status).toBe(200)
      expect(gw.getConfig().server?.maxConcurrentRuns).toBe(5)
    } finally {
      await gw.stop()
    }
  })

  it('redacts sensitive env vars on agents, mcpServers, and backends', async () => {
    const { gw, base } = await bootGatewayWithRetry((port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      runStore: new MemoryRunStore(),
      config: {
        registries: {
          agents: [
            {
              id: 'demo-agent',
              runtime: 'opencode',
              lifecycle: 'ephemeral',
              command: 'opencode',
              env: { OPENAI_API_KEY: 'sk-secret', LOG_LEVEL: 'info' },
            },
          ],
          mcpServers: [
            {
              id: 'demo-mcp',
              transport: 'stdio',
              command: 'mcp-server',
              env: { GH_TOKEN: 'ghp-secret', PORT: '7000' },
            },
          ],
        },
        backends: {
          default: 'demo',
          demo: {
            apiKey: 'inline-key',
            model: 'gpt-4',
            env: { ANOTHER_TOKEN: 't' },
          },
        },
      },
    }))
    try {
      const res = await fetch(`${base}/v1/config`)
      const body = await res.json()
      expect(body.registries.agents[0].env.OPENAI_API_KEY).toBe('[redacted]')
      expect(body.registries.agents[0].env.LOG_LEVEL).toBe('info')
      expect(body.registries.mcpServers[0].env.GH_TOKEN).toBe('[redacted]')
      expect(body.registries.mcpServers[0].env.PORT).toBe('7000')
      expect(body.backends.demo.apiKey).toBe('[redacted]')
      expect(body.backends.demo.model).toBe('gpt-4')
      expect(body.backends.demo.env.ANOTHER_TOKEN).toBe('[redacted]')
      expect(body.backends.default).toBe('demo')
    } finally {
      await gw.stop()
    }
  })
})
