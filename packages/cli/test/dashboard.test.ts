import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

describe('skelm dashboard', () => {
  it('scaffolds a dependency-free TypeScript dashboard project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-dashboard-'))
    const target = join(dir, 'dashboard')

    const { stdout, exitCode } = await invoke(['dashboard', 'init', target])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('scaffolded skelm dashboard')
    expect(stdout).toContain('skelm dashboard start')

    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as {
      dependencies?: unknown
      devDependencies?: unknown
    }
    expect(pkg.dependencies).toBeUndefined()
    expect(pkg.devDependencies).toBeUndefined()
    expect(readFileSync(join(target, 'dashboard.config.mts'), 'utf8')).toContain('DashboardConfig')
    expect(readFileSync(join(target, 'src/server.mts'), 'utf8')).toContain('startDashboardServer')
    expect(readFileSync(join(target, 'src/public/app.mts'), 'utf8')).toContain('type Page')
  })

  it('starts from the CLI without a local install step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-dashboard-'))
    const target = join(dir, 'dashboard')
    await invoke(['dashboard', 'init', target])
    const port = String(await pickPort())
    process.env.SKELM_DASHBOARD_TEST_ONCE = '1'
    try {
      const { stdout, exitCode } = await invoke(['dashboard', 'start', target, '--port', port])
      expect(exitCode).toBe(EXIT.OK)
      expect(stdout).toContain(`http://127.0.0.1:${port}`)
    } finally {
      process.env.SKELM_DASHBOARD_TEST_ONCE = undefined
    }
  })

  it('the generated TypeScript server proxies bearer-auth gateway requests', async () => {
    const gateway = await startGatewayFixture()
    const dir = mkdtempSync(join(tmpdir(), 'skelm-dashboard-'))
    const target = join(dir, 'dashboard')
    await invoke(['dashboard', 'init', target])

    const port = await pickPort()
    const mod = (await import(pathToFileURL(join(target, 'src/server.mts')).href)) as {
      startDashboardServer(opts: {
        port: number
        gatewayUrl: string
        token: string
      }): Promise<{ url: string; close(): Promise<void> }>
    }
    const dashboard = await mod.startDashboardServer({
      port,
      gatewayUrl: gateway.url,
      token: 'sekret',
    })
    try {
      const res = await fetch(`${dashboard.url}/api/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: 'ok' })
      expect(gateway.authorized).toBe(true)
    } finally {
      await dashboard.close()
      await gateway.close()
    }
  })

  it('rejects traversal outside src/public even for sibling prefix matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-dashboard-'))
    const target = join(dir, 'dashboard')
    await invoke(['dashboard', 'init', target])
    mkdirSync(join(target, 'src', 'public2'))
    writeFileSync(join(target, 'src', 'public2', 'secret.txt'), 'top-secret', 'utf8')

    const port = await pickPort()
    const mod = (await import(pathToFileURL(join(target, 'src/server.mts')).href)) as {
      isPathInside(root: string, target: string): boolean
      startDashboardServer(opts: {
        port: number
      }): Promise<{ url: string; close(): Promise<void> }>
    }
    expect(
      mod.isPathInside('/tmp/dashboard/src/public', '/tmp/dashboard/src/public2/secret.txt'),
    ).toBe(false)
    const dashboard = await mod.startDashboardServer({ port })
    try {
      const res = await rawGet(port, '/%2e%2e%2fpublic2/secret.txt')
      expect(res.statusCode).not.toBe(200)
      expect(res.body).not.toContain('top-secret')
    } finally {
      await dashboard.close()
    }
  })

  it('help lists the dashboard command', async () => {
    const { stdout } = await invoke(['dashboard', '--help'])
    expect(stdout).toContain('skelm dashboard init')
    expect(stdout).toContain('--gateway-url')
  })
})

interface InvocationResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function invoke(argv: readonly string[]): Promise<InvocationResult> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdoutChunks.push(chunk.toString())
      cb()
    },
  })
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrChunks.push(chunk.toString())
      cb()
    },
  })
  const stdin = Readable.from([])
  const result = await main(argv, { stdout, stderr, stdin })
  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode: result.exitCode,
  }
}

async function startGatewayFixture(): Promise<{
  url: string
  authorized: boolean
  close(): Promise<void>
}> {
  let authorized = false
  const port = await pickPort()
  const server = createServer((req, res) => {
    if (req.headers.authorization === 'Bearer sekret') authorized = true
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', state: 'running' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return {
    url: `http://127.0.0.1:${port}`,
    get authorized() {
      return authorized
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

async function pickPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (address === null || typeof address === 'string') throw new Error('failed to allocate port')
  return address.port
}

async function rawGet(port: number, path: string): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
      },
      (res) => {
        const chunks: string[] = []
        res.setEncoding('utf8')
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: chunks.join(''),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}
