import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

// Per AGENTS.md every documented CLI exit code must have a test. Prior
// to this suite only OK / CLI_ERROR / SCHEMA_VALIDATION were covered;
// RUN_FAILED, WAIT_TIMEOUT, PERMISSION_DENIED, and STEP_TIMEOUT are
// asserted here against fixture workflows that surface each error mode
// through the existing CLI run path. CANCELLED is exercised separately
// via a spawn-bin test that can deliver SIGTERM mid-run.

const FIXTURES = fileURLToPath(new URL('./fixtures/exit-codes/', import.meta.url))

class Capture extends Writable {
  chunks: string[] = []
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(chunk.toString('utf8'))
    cb()
  }
  text(): string {
    return this.chunks.join('')
  }
}

async function runWorkflow(file: string): Promise<{ exitCode: number; stderr: string }> {
  const stdout = new Capture()
  const stderr = new Capture()
  const stdin = Readable.from([])
  const result = await main(['run', join(FIXTURES, file)], { stdout, stderr, stdin })
  return { exitCode: result.exitCode, stderr: stderr.text() }
}

describe('skelm run — documented exit codes', () => {
  it('EXIT.RUN_FAILED (3) on an uncaught step error', async () => {
    const r = await runWorkflow('run-failed.workflow.ts')
    expect(r.exitCode).toBe(EXIT.RUN_FAILED)
    expect(r.stderr).toMatch(/intentional failure/)
  })

  it('EXIT.PERMISSION_DENIED (6) when ctx.exec is called without an allowlist', async () => {
    const r = await runWorkflow('permission-denied.workflow.ts')
    expect(r.exitCode).toBe(EXIT.PERMISSION_DENIED)
    expect(r.stderr).toMatch(/allowedExecutables|PermissionDenied/i)
  })

  it('EXIT.STEP_TIMEOUT (7) when a step outlives its timeoutMs budget', async () => {
    const r = await runWorkflow('step-timeout.workflow.ts')
    expect(r.exitCode).toBe(EXIT.STEP_TIMEOUT)
    expect(r.stderr).toMatch(/timeout|StepTimeout/i)
  })

  it('EXIT.WAIT_TIMEOUT (5) when a wait step times out before resume', async () => {
    const r = await runWorkflow('wait-timeout.workflow.ts')
    expect(r.exitCode).toBe(EXIT.WAIT_TIMEOUT)
    expect(r.stderr).toMatch(/wait|timeout/i)
  })
})
