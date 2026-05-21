import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../../src/builders.js'
import { EventBus, type RunEvent } from '../../src/events.js'
import type { ExecFn } from '../../src/index.js'
import { runPipeline } from '../../src/runner.js'

// Adversarial coverage for the exec-audit gap: privileged spawns through
// ctx.exec must produce auditable events (tool.call + tool.result on
// success, permission.denied on deny) so the gateway's single audit
// writer records every exec invocation. Without these events the privileged
// action would happen silently in the audit log.

describe('code() exec — audit emission', () => {
  it('emits tool.call + tool.result for a successful exec', async () => {
    const bus = new EventBus()
    const events: RunEvent[] = []
    bus.subscribe((e) => events.push(e))
    const wf = pipeline({
      id: 'wf-audit-success',
      steps: [
        code({
          id: 'echo',
          permissions: { allowedExecutables: ['node'] },
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({
              command: 'node',
              args: ['-e', 'process.stdout.write("ok")'],
            })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { events: bus })
    expect(run.status).toBe('completed')
    const execCalls = events.filter(
      (e): e is Extract<RunEvent, { type: 'tool.call' }> =>
        e.type === 'tool.call' && e.tool.startsWith('exec:'),
    )
    const execResults = events.filter(
      (e): e is Extract<RunEvent, { type: 'tool.result' }> =>
        e.type === 'tool.result' && e.tool.startsWith('exec:'),
    )
    expect(execCalls).toHaveLength(1)
    expect(execResults).toHaveLength(1)
    expect(execCalls[0]?.tool).toBe('exec:node')
    const args = execCalls[0]?.arguments as { binary: string; argv: string[] }
    expect(args.binary).toBe('node')
  })

  it('emits permission.denied with dimension=executable on deny', async () => {
    const bus = new EventBus()
    const events: RunEvent[] = []
    bus.subscribe((e) => events.push(e))
    const wf = pipeline({
      id: 'wf-audit-deny',
      steps: [
        code({
          id: 'forbidden',
          permissions: { allowedExecutables: ['git'] },
          run: async (ctx) => {
            return await (ctx.exec as ExecFn)({ command: 'node' })
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { events: bus })
    expect(run.status).toBe('failed')
    const denies = events.filter(
      (e): e is Extract<RunEvent, { type: 'permission.denied' }> => e.type === 'permission.denied',
    )
    expect(denies.length).toBeGreaterThanOrEqual(1)
    expect(denies[0]?.dimension).toBe('executable')
    expect(denies[0]?.detail).toMatch(/node/)
  })
})
