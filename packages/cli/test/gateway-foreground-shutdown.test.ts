import { type ChildProcess, spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// BUG-042 regression: `skelm gateway start --foreground` must exit 0 on a
// graceful SIGTERM. The bug was dual signal ownership — the gateway installed
// its own SIGTERM handler *and* the CLI installed one, so stop() ran twice and
// the gateway's handler force-exited 1. We spawn the real bin (AGENTS.md: CLI
// commands are tested by spawning the bin) and send it a real SIGTERM.
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

let stateDir: string
let child: ChildProcess | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-cli-gw-fg-'))
})

afterEach(async () => {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
  child = undefined
  await rm(stateDir, { recursive: true, force: true })
})

describe('skelm gateway start --foreground — graceful shutdown', () => {
  it('exits 0 on SIGTERM and removes lock + discovery files', { timeout: 30_000 }, async () => {
    // Subprocess equivalent of bootGatewayWithRetry: pickFreePort releases its
    // probe socket before the child binds, so under vitest parallelism the
    // child can lose the port to a sibling worker and exit early with
    // EADDRINUSE. Retry the spawn on that specific failure (matches the
    // in-process retry pattern PR #247 added to debug.test.ts).
    const MAX_ATTEMPTS = 5
    let started = false
    let stdout = ''
    let stderr = ''
    let lastFailure = ''
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !started; attempt++) {
      const port = await pickFreePort()
      stdout = ''
      stderr = ''
      // cwd = temp dir so loadSkelmConfig walks up to / without finding the
      // repo's own skelm.config (and its backend factories).
      child = spawn(
        process.execPath,
        [BIN, 'gateway', 'start', '--foreground', '--http-port', String(port)],
        {
          cwd: stateDir,
          // DEFAULT_CONFIG references the `openai` backend; a dummy key lets it
          // construct so the gateway can start. The backend is never exercised —
          // we only start and shut down.
          env: {
            ...process.env,
            SKELM_STATE_DIR: stateDir,
            OPENAI_API_KEY: 'sk-test-dummy',
            FORCE_COLOR: '0',
          },
        },
      )
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString()
      })

      // Race the readiness line against an early child exit. If the child
      // exits before "skelm gateway started", inspect stderr: EADDRINUSE is
      // the racy case we retry; anything else is a real failure.
      const earlyExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child?.once('exit', (code, signal) => resolve({ code, signal }))
        },
      )
      try {
        await Promise.race([
          waitFor(
            () => stdout.includes('skelm gateway started'),
            20_000,
            () => stderr,
          ),
          earlyExit.then((res) => {
            throw new Error(
              `child exited early (code=${String(res.code)}, signal=${String(res.signal)}); stderr:\n${stderr}`,
            )
          }),
        ])
        started = true
      } catch (err) {
        lastFailure = String((err as Error)?.message ?? err)
        if (!/EADDRINUSE/i.test(lastFailure)) throw err
        // Best-effort cleanup before the retry.
        if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL')
        child = undefined
      }
    }
    if (!started || child === undefined) {
      throw new Error(
        `could not start --foreground gateway after ${MAX_ATTEMPTS} attempts: ${lastFailure}`,
      )
    }

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child?.once('exit', (code, signal) => resolve({ code, signal }))
      },
    )
    child.kill('SIGTERM')
    const { code } = await exitPromise

    expect(code).toBe(0)
    expect(stdout).toContain('skelm gateway stopped')
    expect(stderr).not.toMatch(/stop failed/)
    expect(await exists(join(stateDir, 'gateway.lock'))).toBe(false)
    expect(await exists(join(stateDir, 'gateway.json'))).toBe(false)
  })
})

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  diag: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`gateway did not become ready within ${timeoutMs}ms; stderr:\n${diag()}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
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
