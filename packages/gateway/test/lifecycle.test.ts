import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Gateway,
  LockfileError,
  acquireLockfile,
  readDiscovery,
  readLockfile,
  releaseLockfile,
} from '../src/index.js'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-gateway-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

describe('Gateway lifecycle', () => {
  it('start writes lockfile + discovery and stop cleans them up', async () => {
    const gw = new Gateway({ stateDir, url: 'http://127.0.0.1:4042' })
    expect(gw.getState()).toBe('stopped')
    await gw.start()
    expect(gw.getState()).toBe('running')

    const lock = await readLockfile(gw.lockfilePath)
    expect(lock?.pid).toBe(process.pid)

    const disc = await readDiscovery(gw.discoveryPath)
    expect(disc?.url).toBe('http://127.0.0.1:4042')
    expect(disc?.pid).toBe(process.pid)

    await gw.stop()
    expect(gw.getState()).toBe('stopped')
    await expect(fs.access(gw.lockfilePath)).rejects.toThrow()
    await expect(fs.access(gw.discoveryPath)).rejects.toThrow()
  })

  it('pause / resume only valid from running / paused', async () => {
    const gw = new Gateway({ stateDir })
    await gw.start()
    await gw.pause()
    expect(gw.getState()).toBe('paused')
    await expect(gw.pause()).rejects.toThrow(/cannot pause/)
    await gw.resume()
    expect(gw.getState()).toBe('running')
    await expect(gw.resume()).rejects.toThrow(/cannot resume/)
    await gw.stop()
  })

  it('reload is a no-op in Phase 2 but rejects from stopped', async () => {
    const gw = new Gateway({ stateDir })
    await expect(gw.reload()).rejects.toThrow(/cannot reload/)
    await gw.start()
    await expect(gw.reload()).resolves.toBeUndefined()
    await gw.stop()
  })

  it('starting twice from running is rejected', async () => {
    const gw = new Gateway({ stateDir })
    await gw.start()
    await expect(gw.start()).rejects.toThrow(/cannot start/)
    await gw.stop()
  })

  it('lockfile contention is detected when held by a live pid', async () => {
    const lockPath = join(stateDir, 'gateway.lock')
    const first = await acquireLockfile(lockPath)
    expect(first.pid).toBe(process.pid)
    await expect(acquireLockfile(lockPath)).rejects.toBeInstanceOf(LockfileError)
    await releaseLockfile(lockPath)
  })

  it('lockfile is reclaimed when the prior holder pid is dead', async () => {
    const lockPath = join(stateDir, 'gateway.lock')
    // PID 1 (init) is always alive, so use a synthetic stale entry: write a
    // record with a pid that cannot exist (max int) and verify reclaim.
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 2_147_483_640, startedAt: new Date(0).toISOString() }),
    )
    const reclaimed = await acquireLockfile(lockPath)
    expect(reclaimed.pid).toBe(process.pid)
    await releaseLockfile(lockPath)
  })

  it('stop is idempotent', async () => {
    const gw = new Gateway({ stateDir })
    await gw.start()
    await gw.stop()
    await expect(gw.stop()).resolves.toBeUndefined()
  })

  it('discovery URL reflects config.server.host/port even without enableHttp', async () => {
    // Embedded use: no `enableHttp`, no explicit `options.url`, but
    // `config.server.port` is non-default. The discovery file must point at
    // the config-declared address — not the documented default.
    const gw = new Gateway({
      stateDir,
      config: {
        server: { port: 4099, host: '127.0.0.1', auth: { mode: 'none' } },
      },
    })
    await gw.start()
    const disc = await readDiscovery(gw.discoveryPath)
    expect(disc?.url).toBe('http://127.0.0.1:4099')
    await gw.stop()
  })

  it('options.httpPort wins over config.server.port for the discovery URL', async () => {
    const gw = new Gateway({
      stateDir,
      httpPort: 4042,
      config: {
        server: { port: 4099, host: '127.0.0.1', auth: { mode: 'none' } },
      },
    })
    await gw.start()
    const disc = await readDiscovery(gw.discoveryPath)
    expect(disc?.url).toBe('http://127.0.0.1:4042')
    await gw.stop()
  })

  it('options.httpPort drives the egress proxy port (proxyPort = httpPort + 1)', async () => {
    // Regression: when --http-port overrides server.port via options.httpPort,
    // the egress proxy used to keep deriving its port from config.server.port
    // (defaulting to 14738+1=14739), so concurrent gateways with distinct
    // --http-port flags still collided on the proxy port.
    const gw = new Gateway({
      stateDir,
      httpPort: 4042,
      config: {
        server: { port: 4099, host: '127.0.0.1', auth: { mode: 'none' } },
      },
    })
    await gw.start()
    const proxyEnv = gw.getProxyEnvVars()
    expect(proxyEnv).toBeDefined()
    expect(proxyEnv?.HTTP_PROXY).toBe('http://127.0.0.1:4043')
    await gw.stop()
  })

  it('explicit options.url still wins over config.server.port', async () => {
    const gw = new Gateway({
      stateDir,
      url: 'http://example.com:9999',
      config: {
        server: { port: 4099, host: '127.0.0.1', auth: { mode: 'none' } },
      },
    })
    await gw.start()
    const disc = await readDiscovery(gw.discoveryPath)
    expect(disc?.url).toBe('http://example.com:9999')
    await gw.stop()
  })
})
