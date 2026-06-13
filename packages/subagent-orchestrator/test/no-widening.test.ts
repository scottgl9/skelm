import {
  BackendRegistry,
  type Context,
  type Pipeline,
  type ResolvedPolicy,
  type SkelmBackend,
  TrustEnforcer,
  agent,
  code,
  pipeline,
} from '@skelm/core'
import { runPipeline } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { fanOut } from '../src/index.js'

// Adversarial: the package helpers COMPOSE ctx.workflows.fanout, which the core
// runtime ceiling-binds. A child declaring broader permissions than the parent
// must get the INTERSECTION (no widening), and starting a child at all is
// default-denied unless the orchestrating step's `delegation` allowlist grants
// the target. This is the orchestration security pattern, exercised through
// the @skelm/subagent-orchestrator surface rather than the raw primitive.

const registryOf = (map: Record<string, Pipeline>) => (id: string) => map[id]

function capturingBackend(sink: ResolvedPolicy[]): SkelmBackend {
  return {
    id: 'capture',
    capabilities: {
      prompt: false,
      streaming: false,
      sessionLifecycle: false,
      mcp: false,
      skills: false,
      modelSelection: false,
      toolPermissions: 'native',
    },
    async run(req) {
      if (req.permissions !== undefined) sink.push(req.permissions)
      return { text: 'ok' }
    },
  }
}

// Child asks for far more than the parent grants, on every dimension.
const greedy = pipeline({
  id: 'greedy',
  steps: [
    agent({
      id: 'work',
      backend: 'capture',
      prompt: 'hi',
      permissions: {
        allowedTools: ['*'],
        allowedExecutables: ['rg', 'bash'],
        allowedSecrets: ['TOKEN_A', 'TOKEN_B'],
        networkEgress: 'allow',
        fsRead: ['/data', '/etc'],
        fsWrite: ['/out', '/'],
        delegation: ['*'],
      },
    }),
  ],
})

const parentGrants = {
  allowedTools: ['safe.*'],
  allowedExecutables: ['rg'],
  allowedSecrets: ['TOKEN_A'],
  networkEgress: { allowHosts: ['api.example.com'] },
  fsRead: ['/data'],
  fsWrite: ['/out'],
  delegation: ['greedy'],
} as const

function orchestrator(body: (ctx: Context) => unknown, permissions?: object): Pipeline {
  return pipeline({
    id: 'parent',
    steps: [code({ id: 'orchestrate', ...(permissions && { permissions }), run: body })],
  })
}

describe('subagent fan-out is permission-ceiling-bound (no widening)', () => {
  it('a child requesting broader permissions gets the parent ∩ child intersection', async () => {
    const captured: ResolvedPolicy[] = []
    const backends = new BackendRegistry()
    backends.register(capturingBackend(captured))
    const parent = orchestrator(
      (ctx) => fanOut(ctx, { tasks: [{ workflowId: 'greedy' }, { workflowId: 'greedy' }] }),
      parentGrants,
    )
    const run = await runPipeline(parent, undefined, {
      backends,
      pipelineRegistry: registryOf({ greedy }),
    })
    expect(run.status).toBe('completed')
    expect(captured).toHaveLength(2)
    for (const policy of captured) {
      const e = new TrustEnforcer(policy)
      // allowedTools: parent safe.* ∩ child * = safe.*
      expect(e.canCallTool('safe.read').allow).toBe(true)
      expect(e.canCallTool('danger.rm').allow).toBe(false)
      // executables: {rg} ∩ {rg,bash} = {rg}
      expect(e.canExec('rg').allow).toBe(true)
      expect(e.canExec('bash').allow).toBe(false)
      // secrets: {TOKEN_A} ∩ {TOKEN_A,TOKEN_B} = {TOKEN_A}
      expect(e.canAccessSecret('TOKEN_A').allow).toBe(true)
      expect(e.canAccessSecret('TOKEN_B').allow).toBe(false)
      // network: allowHosts narrows the child's blanket 'allow'
      expect(e.canFetch('api.example.com').allow).toBe(true)
      expect(e.canFetch('evil.example.com').allow).toBe(false)
      // fs roots intersect
      expect(e.canRead('/data/x').allow).toBe(true)
      expect(e.canRead('/etc/passwd').allow).toBe(false)
      expect(e.canWrite('/out/x').allow).toBe(true)
      expect(e.canWrite('/anywhere').allow).toBe(false)
      // the child cannot re-delegate wider than the parent
      expect(e.canDelegate('greedy').allow).toBe(true)
      expect(e.canDelegate('outsider').allow).toBe(false)
      expect(policy.unrestricted).not.toBe(true)
    }
  })

  it('a caller-supplied ceiling can only narrow, never widen', async () => {
    const captured: ResolvedPolicy[] = []
    const backends = new BackendRegistry()
    backends.register(capturingBackend(captured))
    const parent = orchestrator(
      (ctx) =>
        fanOut(ctx, {
          tasks: [{ workflowId: 'greedy' }],
          // Adversarial: request a WIDER ceiling than the parent's own grant.
          ceiling: { allowedTools: ['*'], allowedExecutables: ['bash'], delegation: ['*'] },
        }),
      { delegation: ['greedy'], allowedTools: ['safe.*'] },
    )
    const run = await runPipeline(parent, undefined, {
      backends,
      pipelineRegistry: registryOf({ greedy }),
    })
    expect(run.status).toBe('completed')
    expect(captured).toHaveLength(1)
    const e = new TrustEnforcer(captured[0] as ResolvedPolicy)
    expect(e.canCallTool('safe.read').allow).toBe(true)
    expect(e.canCallTool('danger.rm').allow).toBe(false)
    // Parent step granted no executables, so the requested bash grant is gone.
    expect(e.canExec('bash').allow).toBe(false)
  })

  it('default-deny: a step with no delegation grant cannot fan out', async () => {
    const parent = orchestrator((ctx) => fanOut(ctx, { tasks: [{ workflowId: 'greedy' }] }))
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ greedy }),
    })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
  })

  it('explicit-deny: a target outside the delegation allowlist is refused', async () => {
    const parent = orchestrator((ctx) => fanOut(ctx, { tasks: [{ workflowId: 'greedy' }] }), {
      delegation: ['some-other-workflow'],
    })
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ greedy }),
    })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
  })
})
