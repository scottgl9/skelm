import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../../src/builders.js'
import type { ExecFn } from '../../src/index.js'
import { runPipeline } from '../../src/runner.js'

// Adversarial coverage for code() + ctx.exec() — the new exec dimension
// that becomes reachable from deterministic steps in this change.
//
// Default-deny: omitting `permissions.allowedExecutables` denies every
// ctx.exec call. Explicit-deny: an allowlist that does NOT include the
// resolved binary's basename denies it.

describe('code() exec — default-deny', () => {
  it('omitted permissions denies every ctx.exec call', async () => {
    const wf = pipeline({
      id: 'wf-default-deny',
      steps: [
        code({
          id: 'try-exec',
          // No permissions field — default-deny.
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({
              command: 'node',
              args: ['-e', 'process.stdout.write("never")'],
            })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(run.error?.message).toMatch(/not in allowedExecutables/)
  })
})

describe('code() exec — explicit-deny', () => {
  it('allowedExecutables that excludes the target denies that binary', async () => {
    const wf = pipeline({
      id: 'wf-explicit-deny',
      steps: [
        code({
          id: 'try-exec',
          permissions: { allowedExecutables: ['git'] },
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({
              command: 'node',
              args: ['-e', 'process.stdout.write("never")'],
            })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(run.error?.message).toMatch(/"node"/)
  })

  it('denies an absolute-path binary when only the basename is allowlisted (no basename-bypass)', async () => {
    // An allowlist of bare ['node'] must NOT accept an arbitrary absolute path
    // whose basename happens to be 'node' — that was the basename-bypass closed
    // in 0366b65. Invoking by path requires the exact path to be allowlisted.
    const nodeBin = process.execPath
    const nodeName = nodeBin.split('/').pop() ?? 'node'
    const wf = pipeline({
      id: 'wf-basename-bypass-denied',
      steps: [
        code({
          id: 'try-abs-path',
          permissions: { allowedExecutables: [nodeName] },
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({
              command: nodeBin,
              args: ['-e', 'process.stdout.write("ok")'],
            })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
  })

  it('absolute paths are accepted when explicitly allowlisted by full path', async () => {
    const wf = pipeline({
      id: 'wf-abs-allowlist',
      steps: [
        code({
          id: 'try-abs-allowed',
          permissions: { allowedExecutables: [process.execPath] },
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({
              command: process.execPath,
              args: ['-e', 'process.stdout.write("ok")'],
            })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
  })

  it('denial surfaces dimension via error message', async () => {
    const wf = pipeline({
      id: 'wf-dimension',
      steps: [
        code({
          id: 'try-exec',
          permissions: { allowedExecutables: ['git'] },
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({ python: './x.py' })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(run.error?.message).toMatch(/python3/)
  })
})
