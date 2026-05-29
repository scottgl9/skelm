import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from '../src/backend.js'
import { agent, code, pipeline } from '../src/builders.js'
import type { ResolvedPolicy } from '../src/permissions.js'
import { TrustEnforcer, resolvePermissions } from '../src/permissions.js'
import { runPipeline } from '../src/runner.js'

// The delegationCeiling run option is what the delegation path passes down to a
// child run: every step's resolved policy must be intersected with it so a
// child can never exceed the delegating agent's grant. These tests drive that
// bound directly through runPipeline (the delegation tool is tested separately).

function capturingBackend(sink: { policy?: ResolvedPolicy }): SkelmBackend {
  return {
    id: 'capture',
    capabilities: {
      prompt: false,
      streaming: false,
      sessionLifecycle: false,
      mcp: false,
      skills: false,
      modelSelection: false,
      toolPermissions: 'wrapped',
    },
    async run(req) {
      sink.policy = req.permissions
      return { text: 'ok' }
    },
  }
}

describe('delegationCeiling — child bounded by parent', () => {
  it('intersects a broad child agent policy with a narrow ceiling', async () => {
    const sink: { policy?: ResolvedPolicy } = {}
    const registry = new BackendRegistry()
    registry.register(capturingBackend(sink))
    const wf = pipeline({
      id: 'child',
      steps: [
        agent({
          id: 'work',
          backend: 'capture',
          prompt: 'hi',
          permissions: { allowedTools: ['*'], allowedExecutables: ['rg', 'bash'] },
        }),
      ],
    })

    const ceiling = resolvePermissions(undefined, {
      allowedTools: ['safe.*'],
      allowedExecutables: ['rg'],
    })
    const run = await runPipeline(wf, undefined, { backends: registry, delegationCeiling: ceiling })
    expect(run.status).toBe('completed')

    const e = new TrustEnforcer(sink.policy as ResolvedPolicy)
    expect(e.canCallTool('safe.read').allow).toBe(true)
    expect(e.canCallTool('danger.rm').allow).toBe(false)
    expect(e.canExec('rg').allow).toBe(true)
    expect(e.canExec('bash').allow).toBe(false)
  })

  it('caps an agent step that declares no policy at the ceiling (no backend-default escape)', async () => {
    const sink: { policy?: ResolvedPolicy } = {}
    const registry = new BackendRegistry()
    registry.register(capturingBackend(sink))
    const wf = pipeline({
      id: 'child-no-perms',
      steps: [agent({ id: 'work', backend: 'capture', prompt: 'hi' })],
    })

    const ceiling = resolvePermissions(undefined, { allowedTools: ['safe.*'] })
    const run = await runPipeline(wf, undefined, { backends: registry, delegationCeiling: ceiling })
    expect(run.status).toBe('completed')
    // Without a ceiling this step would hand the backend an undefined policy
    // (permissive default); under a ceiling it must receive the ceiling itself.
    expect(sink.policy).toBeDefined()
    const e = new TrustEnforcer(sink.policy as ResolvedPolicy)
    expect(e.canCallTool('safe.read').allow).toBe(true)
    expect(e.canCallTool('danger.rm').allow).toBe(false)
  })

  it('bounds a code/exec step too', async () => {
    const registry = new BackendRegistry()
    const wf = pipeline({
      id: 'child-exec',
      steps: [
        code({
          id: 'run-bash',
          run: async (ctx) => {
            await ctx.exec?.({ command: 'bash', args: ['-c', 'echo hi'] })
            return 'ran'
          },
          permissions: { allowedExecutables: ['rg', 'bash'] },
        }),
      ],
    })
    const ceiling = resolvePermissions(undefined, { allowedExecutables: ['rg'] })
    const run = await runPipeline(wf, undefined, { backends: registry, delegationCeiling: ceiling })
    // bash is denied by the ceiling even though the step declared it.
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
  })

  it('leaves runs unbounded when no ceiling is set', async () => {
    const sink: { policy?: ResolvedPolicy } = {}
    const registry = new BackendRegistry()
    registry.register(capturingBackend(sink))
    const wf = pipeline({
      id: 'top-level',
      steps: [
        agent({
          id: 'work',
          backend: 'capture',
          prompt: 'hi',
          permissions: { allowedTools: ['*'] },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { backends: registry })
    expect(run.status).toBe('completed')
    expect(new TrustEnforcer(sink.policy as ResolvedPolicy).canCallTool('anything').allow).toBe(true)
  })
})
