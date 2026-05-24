import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

/**
 * In-process smoke tests for the `skelm gateway` subcommand. We invoke the
 * CLI's main() with argv arrays directly (no subprocess needed) and a temp
 * SKELM_STATE_DIR so the tests don't collide with a developer's running
 * gateway.
 */
let stateDir: string
let priorStateDir: string | undefined
let priorNoAutostart: string | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-cli-gw-'))
  priorStateDir = process.env.SKELM_STATE_DIR
  priorNoAutostart = process.env.SKELM_NO_AUTOSTART
  process.env.SKELM_STATE_DIR = stateDir
  // These tests deliberately exercise "no gateway running" behaviour for
  // commands that now require the gateway. Disable auto-start so the CLI
  // fails fast with a clean error instead of spawning a real gateway.
  process.env.SKELM_NO_AUTOSTART = '1'
})

afterEach(async () => {
  if (priorStateDir === undefined) process.env.SKELM_STATE_DIR = undefined
  else process.env.SKELM_STATE_DIR = priorStateDir
  if (priorNoAutostart === undefined) process.env.SKELM_NO_AUTOSTART = undefined
  else process.env.SKELM_NO_AUTOSTART = priorNoAutostart
  await rm(stateDir, { recursive: true, force: true })
})

describe('skelm gateway — CLI smoke', () => {
  it('status reports "not running" on a clean state dir', async () => {
    const { stdout, exitCode } = await invoke(['gateway', 'status'])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('not running')
  })

  it('status --json returns running:false on a clean state dir', async () => {
    const { stdout, exitCode } = await invoke(['gateway', 'status', '--json'])
    expect(exitCode).toBe(EXIT.OK)
    expect(JSON.parse(stdout)).toMatchObject({ running: false, pid: null })
  })

  it('reports an error for an unknown subcommand', async () => {
    const { stderr, exitCode } = await invoke(['gateway', 'frobnicate'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toContain('gateway requires one of')
  })

  it('--detach no longer prints the legacy "use nohup" pointer', { timeout: 10_000 }, async () => {
    // Detach now actually forks a child via child_process.spawn. The child
    // runs in the background and writes the lockfile under the test's
    // SKELM_STATE_DIR. Either it acquires within the 5s probe (exit OK)
    // or it doesn't (exit CLI_ERROR with a timeout message). Both are
    // acceptable here; what we're locking down is that the deprecated
    // "spawn nohup skelm gateway start --foreground &" text is gone.
    const { stderr, exitCode } = await invoke(['gateway', 'start', '--detach'])
    expect([EXIT.OK, EXIT.CLI_ERROR]).toContain(exitCode)
    expect(stderr).not.toContain('nohup skelm gateway start')
    // Best-effort cleanup: stop whatever the child started.
    try {
      await invoke(['gateway', 'stop'])
    } catch {}
  })

  it('stop fails cleanly when the gateway is not running', async () => {
    const { stderr, exitCode } = await invoke(['gateway', 'stop'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toContain('not running')
  })

  it('approvals list returns empty on a clean state dir', async () => {
    const { stdout, exitCode } = await invoke(['approvals', 'list'])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('no pending approvals')
  })

  it('approvals approve fails cleanly when no gateway is running', async () => {
    const { stderr, exitCode } = await invoke([
      'approvals',
      'approve',
      'run-x:step-y',
      '--approver',
      'alice',
    ])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toContain('not running')
  })

  it('audit query fails cleanly when no gateway is running', async () => {
    const { stderr, exitCode } = await invoke(['audit', 'query'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toMatch(/not running|SKELM_NO_AUTOSTART/)
  })

  // Secrets commands still hit the local file via FileSecretResolver
  // pending the Phase 6 secrets-over-HTTP work; these tests continue to
  // verify local read/write round-trip until that lands.
  it('secrets list returns empty on a clean state dir', async () => {
    const { stdout, exitCode } = await invoke(['secrets', 'list'])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('no secrets configured')
  })

  it('secrets set then get round-trips a value', async () => {
    const setRes = await invoke(['secrets', 'set', 'TEST_KEY', '--value', 's3cret'])
    expect(setRes.exitCode).toBe(EXIT.OK)

    const getRes = await invoke(['secrets', 'get', 'TEST_KEY'])
    expect(getRes.exitCode).toBe(EXIT.OK)
    expect(getRes.stdout.trim()).toBe('s3cret')

    const listRes = await invoke(['secrets', 'list'])
    expect(listRes.stdout).toContain('TEST_KEY')
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

// Acquire a free port for tests that need one (currently unused but kept
// for the next round of integration-style CLI tests).
async function _pickFreePort(): Promise<number> {
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
void _pickFreePort
