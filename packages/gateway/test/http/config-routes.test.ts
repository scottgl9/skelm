import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../../src/index.js'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-config-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

async function boot(): Promise<{ gw: Gateway; base: string }> {
  const port = await pickFreePort()
  const gw = new Gateway({
    stateDir,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    runStore: new MemoryRunStore(),
    config: {
      server: { auth: { mode: 'none' }, maxConcurrentRuns: 4 },
      secrets: { driver: 'file', file: '/etc/skelm/secrets.json' },
    },
  })
  await gw.start()
  return { gw, base: `http://127.0.0.1:${port}` }
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
})

async function pickFreePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error('port pick failed'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}
