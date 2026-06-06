import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultStateDir,
  detectServiceManager,
  discoveryFromEnvUrl,
  findFreePort,
  gatewayStateDir,
  httpError,
  isServiceInstalled,
  loadDiscovery,
  openSse,
  requireGateway,
  waitForReady,
} from '../src/internal/gateway-client.js'
import type { MainIO } from '../src/internal/io.js'

let stateDir: string
let priorStateDir: string | undefined
let priorNoAutostart: string | undefined
let priorCi: string | undefined
let priorGatewayUrl: string | undefined
let priorGatewayToken: string | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-cli-gwc-'))
  priorStateDir = process.env.SKELM_STATE_DIR
  priorNoAutostart = process.env.SKELM_NO_AUTOSTART
  priorCi = process.env.CI
  priorGatewayUrl = process.env.SKELM_GATEWAY_URL
  priorGatewayToken = process.env.SKELM_GATEWAY_TOKEN
  process.env.SKELM_STATE_DIR = stateDir
  process.env.SKELM_NO_AUTOSTART = '1'
  process.env.CI = 'false'
  // Blank rather than `delete` (Biome forbids the delete operator);
  // discoveryFromEnvUrl treats an empty/whitespace URL as "unset".
  process.env.SKELM_GATEWAY_URL = ''
  process.env.SKELM_GATEWAY_TOKEN = ''
})

afterEach(async () => {
  process.env.SKELM_STATE_DIR = priorStateDir
  process.env.SKELM_NO_AUTOSTART = priorNoAutostart
  process.env.CI = priorCi
  process.env.SKELM_GATEWAY_URL = priorGatewayUrl ?? ''
  process.env.SKELM_GATEWAY_TOKEN = priorGatewayToken ?? ''
  await rm(stateDir, { recursive: true, force: true })
})

describe('gateway-client', () => {
  it('gatewayStateDir honors SKELM_STATE_DIR', () => {
    expect(gatewayStateDir()).toBe(stateDir)
  })

  it('defaultStateDir is ~/.skelm and differs from a custom SKELM_STATE_DIR', () => {
    expect(defaultStateDir()).toBe(join(homedir(), '.skelm'))
    // The auto-start free-port path keys off this inequality: a custom state
    // dir must NOT be treated as the default (else it would reuse the fixed port).
    expect(stateDir).not.toBe(defaultStateDir())
  })

  it('findFreePort returns distinct, bindable ports for ad-hoc gateways', async () => {
    const a = await findFreePort()
    const b = await findFreePort()
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
    // Must actually be bindable (the port is released before we return it).
    const { createServer } = await import('node:net')
    await new Promise<void>((resolve, reject) => {
      const srv = createServer()
      srv.once('error', reject)
      srv.listen(a, '127.0.0.1', () => srv.close(() => resolve()))
    })
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

  it('requireGateway ignores stale discovery records before deciding whether to auto-start', async () => {
    await writeFile(
      join(stateDir, 'gateway.json'),
      JSON.stringify({
        pid: 12345,
        url: 'http://127.0.0.1:1',
        startedAt: new Date().toISOString(),
      }),
    )
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

  it('discoveryFromEnvUrl is null when SKELM_GATEWAY_URL is unset', () => {
    expect(discoveryFromEnvUrl()).toBeNull()
  })

  it('discoveryFromEnvUrl builds a record from SKELM_GATEWAY_URL (trailing slash trimmed)', () => {
    process.env.SKELM_GATEWAY_URL = 'http://localhost:14777/'
    const disc = discoveryFromEnvUrl()
    expect(disc?.url).toBe('http://localhost:14777')
    expect(disc?.token).toBeUndefined()
  })

  it('discoveryFromEnvUrl carries SKELM_GATEWAY_TOKEN when set', () => {
    process.env.SKELM_GATEWAY_URL = 'http://localhost:14777'
    process.env.SKELM_GATEWAY_TOKEN = 'secret-tok'
    expect(discoveryFromEnvUrl()?.token).toBe('secret-tok')
  })

  it('requireGateway targets SKELM_GATEWAY_URL directly, bypassing discovery and auto-start', async () => {
    // No gateway.json exists and SKELM_NO_AUTOSTART=1, so without the URL env
    // requireGateway would return null. The explicit URL must win.
    process.env.SKELM_GATEWAY_URL = 'http://localhost:14777'
    process.env.SKELM_GATEWAY_TOKEN = 'tok'
    const io = mkIo()
    const client = await requireGateway(io.io)
    expect(client).not.toBeNull()
    expect(client?.discovery.url).toBe('http://localhost:14777')
    expect(client?.headers.authorization).toBe('Bearer tok')
    expect(io.err()).toBe('')
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

  describe('httpError', () => {
    it('extracts message from structured gateway error body', async () => {
      const io = mkIo()
      const res = new Response(
        JSON.stringify({ name: 'H3Error', message: 'workflow not found', statusCode: 404 }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      )
      const result = await httpError(res, io.io)
      expect(result.exitCode).toBe(1)
      expect(io.err()).toContain('404')
      expect(io.err()).toContain('workflow not found')
    })

    it('falls back to raw text when body is not the gateway envelope', async () => {
      const io = mkIo()
      const res = new Response('plain text body', { status: 500 })
      await httpError(res, io.io)
      expect(io.err()).toContain('500')
      expect(io.err()).toContain('plain text body')
    })

    it('falls back to raw text when JSON has no message field', async () => {
      const io = mkIo()
      const res = new Response(JSON.stringify({ ok: false }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })
      await httpError(res, io.io)
      expect(io.err()).toContain('502')
      // raw body kept since no top-level `message`
      expect(io.err()).toContain('"ok":false')
    })
  })

  it('openSse parses split SSE frames with event names, ids, and JSON data', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': ignored comment\n\n')
      res.write('id: 1\nevent: run\n')
      res.write('data: {"ok":true}\n\n')
      res.write('event: note\ndata: plain\n\n')
      res.end('data: incomplete')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    if (addr === null || typeof addr === 'string') {
      server.close()
      throw new Error('no port')
    }

    try {
      const events = []
      for await (const event of openSse(`http://127.0.0.1:${addr.port}/events`, {})) {
        events.push(event)
      }

      expect(events).toEqual([
        { event: 'run', id: '1', raw: '{"ok":true}', data: { ok: true } },
        { event: 'note', id: undefined, raw: 'plain', data: 'plain' },
      ])
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
