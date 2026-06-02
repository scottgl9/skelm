import { afterEach, describe, expect, it } from 'vitest'
import { code, pipeline, wait } from '../src/builders.js'
import type { AuditWriter, ExecFn } from '../src/index.js'
import { MemoryRunStore } from '../src/run-store.js'
import type { RunId, RunPatch } from '../src/run-store.js'
import { runPipeline } from '../src/runner.js'

// Audit / durability writes used to end in `.catch(() => {})`, so a failing
// AuditWriter or run-store dropped privileged-action records and the
// load-bearing wait/resume status flip with no operator signal. The writes are
// still best-effort (they must not poison the run) but failures are now logged.

let restore: (() => void) | undefined
function captureStderr(): { lines: () => string } {
  const captured: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stderr.write
  restore = () => {
    process.stderr.write = orig
  }
  return { lines: () => captured.join('') }
}

afterEach(() => {
  restore?.()
  restore = undefined
})

describe('audit write failures are surfaced, not swallowed', () => {
  it('logs an audit-write failure to stderr and still finalises the run', async () => {
    const writer: AuditWriter = {
      async write() {
        throw new Error('disk full')
      },
    }
    const wf = pipeline({
      id: 'audit-fail',
      steps: [
        code({
          id: 'exec',
          // Declares a policy with no allowedExecutables → exec is denied,
          // which emits permission.denied → an audit write is attempted.
          permissions: { allowedExecutables: [] },
          run: async (ctx) => (ctx.exec as ExecFn)({ command: 'node', args: ['-e', ''] }),
        }),
      ],
    })

    const out = captureStderr()
    const run = await runPipeline(wf, undefined, { auditWriter: writer })

    expect(run.status).toBe('failed') // the exec denial
    expect(out.lines()).toContain('[skelm audit] write failed')
    expect(out.lines()).toContain('permission.denied')
  })
})

describe('wait/resume run-store write failures are surfaced', () => {
  it('logs a failed waiting/resume status write and still completes the run', async () => {
    // Throws on exactly the wait/resume status flips (the patches that carry a
    // `waiting` key); run start/finalize writes go through untouched.
    class FlakyStore extends MemoryRunStore {
      override async updateRun(runId: RunId, patch: RunPatch): Promise<void> {
        if ('waiting' in patch) throw new Error('store offline')
        return super.updateRun(runId, patch)
      }
    }

    const wf = pipeline({
      id: 'wait-resume-fail',
      steps: [wait({ id: 'pause' })],
    })

    const out = captureStderr()
    const run = await runPipeline(wf, undefined, {
      store: new FlakyStore(),
      waitForInput: async () => ({ resumed: true }),
    })

    expect(run.status).toBe('completed')
    expect(out.lines()).toContain('[skelm run-store]')
    expect(out.lines()).toContain('waiting-status')
    expect(out.lines()).toContain('resume-status')
  })
})
