import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from '../../src/backend.js'
import { agent, code, pipeline } from '../../src/builders.js'
import { type DelegationCaller, runDelegation } from '../../src/execution/handlers.js'
import type { ExecutionRuntime } from '../../src/execution/runtime.js'
import type { ResolvedPolicy } from '../../src/permissions.js'
import { TrustEnforcer, resolvePermissions } from '../../src/permissions.js'
import type { Pipeline } from '../../src/types.js'

// Adversarial: a delegated child must never exceed the delegating agent's
// grant, no matter what the child pipeline declares for itself. runDelegation
// passes the caller's resolved policy down as the child run's delegationCeiling.

function makeRuntime(pipelineRegistry: ExecutionRuntime['pipelineRegistry']): ExecutionRuntime {
  return {
    delegationStack: ['root'],
    delegationDepth: 0,
    maxDelegationDepth: 8,
    pipelineRegistry,
  } as unknown as ExecutionRuntime
}

function caller(ceiling: ResolvedPolicy): DelegationCaller {
  return { runId: 'parent', stepId: 'router', signal: new AbortController().signal, ceiling }
}

const registryOf =
  (map: Record<string, Pipeline>): ExecutionRuntime['pipelineRegistry'] =>
  (id: string) =>
    map[id]

describe('delegation bounding — child cannot exceed parent', () => {
  it('a child exec is denied when the parent ceiling forbids it, even if the child declares it', async () => {
    // Child declares bash; parent ceiling only permits rg → bash is denied,
    // so the child run fails and the delegation reports failed (no escape).
    const risky = pipeline({
      id: 'risky',
      steps: [
        code({
          id: 'run-bash',
          run: async (ctx) => {
            await ctx.exec?.({ command: 'bash', args: ['-c', 'echo hi'] })
            return 'ran'
          },
          permissions: { allowedExecutables: ['bash'] },
        }),
      ],
    })
    const ceiling = resolvePermissions(undefined, { allowedExecutables: ['rg'] })
    const result = await runDelegation(
      'risky',
      undefined,
      caller(ceiling),
      makeRuntime(registryOf({ risky })),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toContain('denied')
  })

  it("a child agent's broad tool grant is intersected with the parent ceiling", async () => {
    const sink: { policy?: ResolvedPolicy } = {}
    const captureBackend: SkelmBackend = {
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
    const backends = new BackendRegistry()
    backends.register(captureBackend)

    const specialist = pipeline({
      id: 'specialist',
      steps: [
        agent({
          id: 'work',
          backend: 'capture',
          prompt: 'hi',
          // Child asks for everything and to re-delegate anywhere.
          permissions: { allowedTools: ['*'], delegation: ['*'] },
        }),
      ],
    })

    const ceiling = resolvePermissions(undefined, {
      allowedTools: ['safe.*'],
      delegation: ['team.*'],
    })
    const result = await runDelegation(
      'specialist',
      undefined,
      caller(ceiling),
      makeRuntime(registryOf({ specialist })),
      backends,
    )
    expect(result.status).toBe('completed')

    const e = new TrustEnforcer(sink.policy as ResolvedPolicy)
    expect(e.canCallTool('safe.read').allow).toBe(true)
    expect(e.canCallTool('danger.rm').allow).toBe(false)
    // Re-delegation cannot widen past the parent's delegation allowlist.
    expect(e.canDelegate('team.writer').allow).toBe(true)
    expect(e.canDelegate('outsider.agent').allow).toBe(false)
  })
})
