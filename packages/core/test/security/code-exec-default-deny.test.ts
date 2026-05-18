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
