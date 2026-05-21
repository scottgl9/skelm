import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import type { ExecFn, ExecResult } from '../src/index.js'
import { runPipeline } from '../src/runner.js'

describe('code() — ctx.exec()', () => {
  it('runs a native binary and captures stdout', async () => {
    const wf = pipeline({
      id: 'wf-exec',
      steps: [
        code({
          id: 'echo',
          permissions: { allowedExecutables: ['node'] },
          run: async (ctx) => {
            const result = await (ctx.exec as ExecFn)({
              command: 'node',
              args: ['-e', 'process.stdout.write("hello")'],
            })
            return result
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    const out = run.steps[0]?.output as ExecResult
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toBe('hello')
    expect(out.timedOut).toBe(false)
  })

  it('returns non-zero exit code by default (no throw)', async () => {
    const wf = pipeline({
      id: 'wf-nonzero',
      steps: [
        code({
          id: 'fail',
          permissions: { allowedExecutables: ['node'] },
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({
              command: 'node',
              args: ['-e', 'process.exit(2)'],
            })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    const out = run.steps[0]?.output as ExecResult
    expect(out.exitCode).toBe(2)
  })

  it('throws when throwOnNonZero is set', async () => {
    const wf = pipeline({
      id: 'wf-throw',
      steps: [
        code({
          id: 'fail',
          permissions: { allowedExecutables: ['node'] },
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({
              command: 'node',
              args: ['-e', 'process.exit(3)'],
              throwOnNonZero: true,
            })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.message).toMatch(/exited with code 3/)
  })

  it('honors timeoutMs and reports timedOut', async () => {
    const wf = pipeline({
      id: 'wf-timeout',
      steps: [
        code({
          id: 'sleep',
          permissions: { allowedExecutables: ['node'] },
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({
              command: 'node',
              args: ['-e', 'setTimeout(() => {}, 60_000)'],
              timeoutMs: 100,
            })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    const out = run.steps[0]?.output as ExecResult
    expect(out.timedOut).toBe(true)
    expect(out.exitCode).not.toBe(0)
  })

  it('passes stdin to the child', async () => {
    const wf = pipeline({
      id: 'wf-stdin',
      steps: [
        code({
          id: 'cat',
          permissions: { allowedExecutables: ['node'] },
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({
              command: 'node',
              args: [
                '-e',
                'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(s.toUpperCase()))',
              ],
              stdin: 'echo me',
            })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    const out = run.steps[0]?.output as ExecResult
    expect(out.stdout).toBe('ECHO ME')
  })

  it('resolves the python: shortcut to python3 (interpreter is what gets checked)', async () => {
    const wf = pipeline({
      id: 'wf-python-denied',
      steps: [
        code({
          id: 'py',
          // Allowlist intentionally excludes python3 so we observe the
          // resolved interpreter being checked.
          permissions: { allowedExecutables: ['node'] },
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({ python: './never-runs.py' })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.message).toMatch(/python3/)
  })

  it('rejects requests that mix command and python', async () => {
    const wf = pipeline({
      id: 'wf-bad-shape',
      steps: [
        code({
          id: 'oops',
          permissions: { allowedExecutables: ['node', 'python3', 'bash'] },
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({ command: 'node', python: './x.py' })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.message).toMatch(/exactly one of command\/python\/bash/)
  })
})
