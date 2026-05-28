import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Gateway } from '@skelm/gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

let stateDir: string
let priorStateDir: string | undefined
let priorNoAutostart: string | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-cli-dbg-'))
  priorStateDir = process.env.SKELM_STATE_DIR
  priorNoAutostart = process.env.SKELM_NO_AUTOSTART
  process.env.SKELM_STATE_DIR = stateDir
  // The "gateway is not running" case below deliberately exercises the
  // no-gateway path. Disable auto-start so the CLI fails fast with a clean
  // error instead of spawning a real ad-hoc gateway and waiting for readiness.
  process.env.SKELM_NO_AUTOSTART = '1'
})

afterEach(async () => {
  if (priorStateDir === undefined) process.env.SKELM_STATE_DIR = undefined
  else process.env.SKELM_STATE_DIR = priorStateDir
  if (priorNoAutostart === undefined) process.env.SKELM_NO_AUTOSTART = undefined
  else process.env.SKELM_NO_AUTOSTART = priorNoAutostart
  await rm(stateDir, { recursive: true, force: true })
})

describe('skelm debug — CLI smoke', () => {
  it('errors out with usage when invoked without a subcommand', async () => {
    const { stderr, exitCode } = await invoke(['debug'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toContain('debug requires')
  })

  it('errors out when the gateway is not running', async () => {
    const { stderr, exitCode } = await invoke(['debug', 'breakpoints'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toContain('gateway is not running')
  })

  it('add → breakpoints → remove round-trip against a real gateway', async () => {
    const { gw } = await bootGatewayWithRetry((port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      url: `http://127.0.0.1:${port}`,
      config: {},
    }))
    try {
      const added = await invoke(['debug', 'add', 'agent-step'])
      expect(added.exitCode).toBe(EXIT.OK)
      expect(added.stdout).toContain('added agent-step')

      const list = await invoke(['debug', 'breakpoints'])
      expect(list.exitCode).toBe(EXIT.OK)
      expect(list.stdout).toContain('agent-step')

      const removed = await invoke(['debug', 'remove', 'agent-step'])
      expect(removed.exitCode).toBe(EXIT.OK)
      expect(removed.stdout).toContain('removed agent-step')

      const empty = await invoke(['debug', 'breakpoints'])
      expect(empty.stdout).toContain('no breakpoints set')
    } finally {
      await gw.stop()
    }
  })

  it('release fires against a paused run and returns the run id', async () => {
    const { gw } = await bootGatewayWithRetry((port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      url: `http://127.0.0.1:${port}`,
      config: {},
    }))
    try {
      const pausePromise = gw.breakpoints.pause({
        runId: 'r-cli',
        stepId: 'agent-step',
        kind: 'agent',
      })

      const list = await invoke(['debug', 'runs', '--json'])
      expect(list.exitCode).toBe(EXIT.OK)
      const paused = JSON.parse(list.stdout) as Array<{ runId: string }>
      expect(paused.map((p) => p.runId)).toContain('r-cli')

      const released = await invoke(['debug', 'release', 'r-cli'])
      expect(released.exitCode).toBe(EXIT.OK)
      expect(released.stdout).toContain('released r-cli')
      await pausePromise
    } finally {
      await gw.stop()
    }
  })
})

interface InvokeResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function invoke(argv: readonly string[]): Promise<InvokeResult> {
  let stdout = ''
  let stderr = ''
  const result = await main(argv, {
    stdout: makeWritable((s) => {
      stdout += s
    }),
    stderr: makeWritable((s) => {
      stderr += s
    }),
    stdin: Readable.from([]),
  })
  return { stdout, stderr, exitCode: result.exitCode }
}

function makeWritable(append: (s: string) => void): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      append(chunk.toString())
      cb()
    },
  })
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
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

/**
 * Boot a Gateway with retry on EADDRINUSE. vitest runs many test files in
 * parallel; the OS-assigned ephemeral port from pickFreePort() is occasionally
 * grabbed by a sibling worker between port-pick and Gateway.start()'s bind.
 * A handful of retries collapse the race window to ~microseconds — mirrors
 * packages/gateway/test/utils/boot-gateway.ts (which can't be imported here
 * since this is the CLI package's test suite).
 */
async function bootGatewayWithRetry(
  optionsFactory: (port: number) => ConstructorParameters<typeof Gateway>[0],
  retries = 5,
): Promise<{ gw: Gateway; port: number }> {
  let lastErr: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    const port = await pickFreePort()
    const gw = new Gateway(optionsFactory(port))
    try {
      await gw.start()
      return { gw, port }
    } catch (err) {
      lastErr = err
      try {
        await gw.stop()
      } catch {
        // ignore
      }
      if (!/EADDRINUSE/.test(String((err as Error)?.message ?? err))) throw err
    }
  }
  throw new Error(`bootGatewayWithRetry: exhausted ${retries} retries (${String(lastErr)})`)
}
