import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectServiceManager,
  gatewayStateDir,
  isServiceInstalled,
  loadDiscovery,
  requireGateway,
  waitForReady,
} from '../src/internal/gateway-client.js'
import type { MainIO } from '../src/internal/io.js'

let stateDir: string
let priorStateDir: string | undefined
let priorNoAutostart: string | undefined
let priorCi: string | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-cli-gwc-'))
  priorStateDir = process.env.SKELM_STATE_DIR
  priorNoAutostart = process.env.SKELM_NO_AUTOSTART
  priorCi = process.env.CI
  process.env.SKELM_STATE_DIR = stateDir
  process.env.SKELM_NO_AUTOSTART = '1'
  process.env.CI = 'false'
})

afterEach(async () => {
  process.env.SKELM_STATE_DIR = priorStateDir
  process.env.SKELM_NO_AUTOSTART = priorNoAutostart
  process.env.CI = priorCi
  await rm(stateDir, { recursive: true, force: true })
})

describe('gateway-client', () => {
  it('gatewayStateDir honors SKELM_STATE_DIR', () => {
    expect(gatewayStateDir()).toBe(stateDir)
  })

  it('detectServiceManager returns a valid value for the host', () => {
    const v = detectServiceManager()
    expect(['systemd', 'launchd', 'none']).toContain(v)
  })

  it('isServiceInstalled returns false when no unit/plist is present', async () => {
    // We can't safely poke real user systemd / LaunchAgent paths here, but
    // 'none' must always be false regardless of host.
    expect(await isServiceInstalled('none')).toBe(false)
  })

  it('loadDiscovery returns null when no gateway is running', async () => {
    expect(await loadDiscovery(stateDir)).toBeNull()
  })

  it('loadDiscovery returns the record when one is present', async () => {
    await writeFile(
      join(stateDir, 'gateway.json'),
      JSON.stringify({
        pid: 12345,
        url: 'http://127.0.0.1:9999',
        startedAt: new Date().toISOString(),
      }),
    )
    const disc = await loadDiscovery(stateDir)
    expect(disc).not.toBeNull()
    expect(disc?.pid).toBe(12345)
    expect(disc?.url).toBe('http://127.0.0.1:9999')
  })

  it('waitForReady returns null on timeout when no gateway appears', async () => {
    const start = Date.now()
    const disc = await waitForReady(stateDir, 600)
    expect(disc).toBeNull()
    expect(Date.now() - start).toBeGreaterThanOrEqual(500)
  })

  it('requireGateway with SKELM_NO_AUTOSTART=1 fails cleanly when nothing is running', async () => {
    const io = mkIo()
    const client = await requireGateway(io.io)
    expect(client).toBeNull()
    expect(io.err()).toContain('SKELM_NO_AUTOSTART')
  })

  it('requireGateway refuses to auto-start in CI without explicit opt-in', async () => {
    process.env.CI = 'true'
    process.env.SKELM_NO_AUTOSTART = undefined
    const io = mkIo()
    const client = await requireGateway(io.io)
    expect(client).toBeNull()
    expect(io.err()).toContain('SKELM_AUTOSTART_IN_CI')
  })

  it('requireGateway returns a client when a discovery record is already present', async () => {
    // Stand up a tiny HTTP server that answers /readyz so requireGateway
    // doesn't try to auto-start.
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      if (req.url === '/readyz') {
        res.statusCode = 200
        res.end('ok')
        return
      }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    if (addr === null || typeof addr === 'string') {
      server.close()
      throw new Error('no port')
    }
    const url = `http://127.0.0.1:${addr.port}`
    await writeFile(
      join(stateDir, 'gateway.json'),
      JSON.stringify({ pid: process.pid, url, startedAt: new Date().toISOString() }),
    )
    try {
      const io = mkIo()
      const client = await requireGateway(io.io)
      expect(client).not.toBeNull()
      expect(client?.discovery.url).toBe(url)
      expect(client?.headers['content-type']).toBe('application/json')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

function mkIo(): { io: MainIO; out: () => string; err: () => string } {
  let stdout = ''
  let stderr = ''
  const io: MainIO = {
    stdout: new Writable({
      write(chunk, _e, cb) {
        stdout += chunk.toString()
        cb()
      },
    }),
    stderr: new Writable({
      write(chunk, _e, cb) {
        stderr += chunk.toString()
        cb()
      },
    }),
    stdin: Readable.from([]),
  }
  return { io, out: () => stdout, err: () => stderr }
}
