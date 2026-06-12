import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from '../../src/backend.js'
import { agent, code, pipeline } from '../../src/builders.js'
import type { Pipeline, WorkflowInvokeResult } from '../../src/index.js'
import type { ResolvedPolicy } from '../../src/permissions.js'
import { TrustEnforcer } from '../../src/permissions.js'
import { MemoryRunStore } from '../../src/run-store.js'
import { runPipeline } from '../../src/runner.js'

// Adversarial: children started via ctx.workflows.invoke / ctx.workflows.fanout
// / ctx.tasks.spawn are bounded by the calling step's resolved policy (the
// delegation ceiling). A child that declares broader permissions than the
// parent gets the INTERSECTION on every dimension — and starting a child at
// all is default-denied unless the step's `delegation` allowlist grants the
// target id.

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
      toolPermissions: 'native',
    },
    async run(req) {
      sink.policy = req.permissions
      return { text: 'ok' }
    },
  }
}

const registryOf = (map: Record<string, Pipeline>) => (id: string) => map[id]

// Child asks for far more than the parent grants, on every dimension.
function greedyChild(): Pipeline {
  return pipeline({
    id: 'greedy',
    steps: [
      agent({
        id: 'work',
        backend: 'capture',
        prompt: 'hi',
        permissions: {
          allowedTools: ['*'],
          allowedExecutables: ['rg', 'bash'],
          allowedMcpServers: ['mcp-a', 'mcp-b'],
          allowedSecrets: ['TOKEN_A', 'TOKEN_B'],
          networkEgress: 'allow',
          fsRead: ['/data', '/etc'],
          fsWrite: ['/out', '/'],
          delegation: ['*'],
        },
      }),
    ],
  })
}

const parentGrants = {
  allowedTools: ['safe.*'],
  allowedExecutables: ['rg'],
  allowedMcpServers: ['mcp-a'],
  allowedSecrets: ['TOKEN_A'],
  networkEgress: { allowHosts: ['api.example.com'] },
  fsRead: ['/data'],
  fsWrite: ['/out'],
  delegation: ['greedy'],
} as const

function assertIntersection(policy: ResolvedPolicy): void {
  const e = new TrustEnforcer(policy)
  // allowedTools: parent safe.* ∩ child * = safe.*
  expect(e.canCallTool('safe.read').allow).toBe(true)
  expect(e.canCallTool('danger.rm').allow).toBe(false)
  // allowedExecutables: {rg} ∩ {rg,bash} = {rg}
  expect(e.canExec('rg').allow).toBe(true)
  expect(e.canExec('bash').allow).toBe(false)
  // allowedMcpServers: {mcp-a} ∩ {mcp-a,mcp-b} = {mcp-a}
  expect(e.canAttachMcpServer('mcp-a').allow).toBe(true)
  expect(e.canAttachMcpServer('mcp-b').allow).toBe(false)
  // allowedSecrets: {TOKEN_A} ∩ {TOKEN_A,TOKEN_B} = {TOKEN_A}
  expect(e.canAccessSecret('TOKEN_A').allow).toBe(true)
  expect(e.canAccessSecret('TOKEN_B').allow).toBe(false)
  // networkEgress: allowHosts narrows the child's blanket 'allow'
  expect(e.canFetch('api.example.com').allow).toBe(true)
  expect(e.canFetch('evil.example.com').allow).toBe(false)
  // fsRead / fsWrite: path roots intersect
  expect(e.canRead('/data/file.txt').allow).toBe(true)
  expect(e.canRead('/etc/passwd').allow).toBe(false)
  expect(e.canWrite('/out/result.json').allow).toBe(true)
  expect(e.canWrite('/anywhere').allow).toBe(false)
  // delegation: {greedy} ∩ * = {greedy}; the child cannot re-delegate wider
  expect(e.canDelegate('greedy').allow).toBe(true)
  expect(e.canDelegate('outsider').allow).toBe(false)
  expect(policy.unrestricted).not.toBe(true)
}

describe('ctx.workflows.invoke — ceiling bounding (adversarial)', () => {
  it('intersects a broader child policy with the calling step policy on every dimension', async () => {
    const sink: { policy?: ResolvedPolicy } = {}
    const backends = new BackendRegistry()
    backends.register(capturingBackend(sink))
    const greedy = greedyChild()
    const parent = pipeline({
      id: 'parent',
      steps: [
        code({
          id: 'orchestrate',
          permissions: parentGrants,
          run: (ctx) => ctx.workflows?.invoke({ pipelineId: 'greedy' }),
        }),
      ],
    })
    const run = await runPipeline(parent, undefined, {
      backends,
      pipelineRegistry: registryOf({ greedy }),
    })
    expect(run.status).toBe('completed')
    expect(sink.policy).toBeDefined()
    assertIntersection(sink.policy as ResolvedPolicy)
  })

  it('default-deny: a step with NO permissions cannot invoke any child', async () => {
    const greedy = greedyChild()
    const parent = pipeline({
      id: 'parent-no-perms',
      steps: [
        code({
          id: 'orchestrate',
          run: (ctx) => ctx.workflows?.invoke({ pipelineId: 'greedy' }),
        }),
      ],
    })
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ greedy }),
    })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
  })

  it('explicit-deny: a target outside the delegation allowlist is refused', async () => {
    const greedy = greedyChild()
    const parent = pipeline({
      id: 'parent-wrong-target',
      steps: [
        code({
          id: 'orchestrate',
          permissions: { delegation: ['some-other-workflow'] },
          run: (ctx) => ctx.workflows?.invoke({ pipelineId: 'greedy' }),
        }),
      ],
    })
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ greedy }),
    })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
  })

  it('a caller-supplied ceiling can only narrow, never widen', async () => {
    const sink: { policy?: ResolvedPolicy } = {}
    const backends = new BackendRegistry()
    backends.register(capturingBackend(sink))
    const greedy = greedyChild()
    const parent = pipeline({
      id: 'parent-widen-attempt',
      steps: [
        code({
          id: 'orchestrate',
          permissions: { delegation: ['greedy'], allowedTools: ['safe.*'] },
          run: (ctx) =>
            // Adversarial: the caller asks for a WIDER ceiling than its own
            // policy. The requested ceiling is intersected with the step
            // policy, so the child still cannot exceed the parent.
            ctx.workflows?.invoke({
              pipelineId: 'greedy',
              ceiling: { allowedTools: ['*'], allowedExecutables: ['bash'], delegation: ['*'] },
            }),
        }),
      ],
    })
    const run = await runPipeline(parent, undefined, {
      backends,
      pipelineRegistry: registryOf({ greedy }),
    })
    expect(run.status).toBe('completed')
    const e = new TrustEnforcer(sink.policy as ResolvedPolicy)
    expect(e.canCallTool('safe.read').allow).toBe(true)
    expect(e.canCallTool('danger.rm').allow).toBe(false)
    // Parent step granted no executables, so the requested bash grant is gone.
    expect(e.canExec('bash').allow).toBe(false)
  })

  it('a child cannot gain unrestricted through delegation even when the operator grant is live', async () => {
    const sink: { policy?: ResolvedPolicy } = {}
    const backends = new BackendRegistry()
    backends.register(capturingBackend(sink))
    const escalator = pipeline({
      id: 'escalator',
      steps: [
        agent({
          id: 'work',
          backend: 'capture',
          prompt: 'hi',
          permissions: { requestUnrestricted: true, allowedTools: ['*'] },
        }),
      ],
    })
    const parent = pipeline({
      id: 'parent-restricted',
      steps: [
        code({
          id: 'orchestrate',
          permissions: { delegation: ['escalator'], allowedTools: ['safe.*'] },
          run: (ctx) => ctx.workflows?.invoke({ pipelineId: 'escalator' }),
        }),
      ],
    })
    const run = await runPipeline(parent, undefined, {
      backends,
      pipelineRegistry: registryOf({ escalator }),
      // Operator grant is live for the project, but the restricted parent
      // ceiling must still cap the child to normal enforcement.
      unrestrictedGrant: true,
    })
    expect(run.status).toBe('completed')
    expect(sink.policy).toBeDefined()
    expect((sink.policy as ResolvedPolicy).unrestricted).not.toBe(true)
    const e = new TrustEnforcer(sink.policy as ResolvedPolicy)
    expect(e.canCallTool('danger.rm').allow).toBe(false)
  })

  it('depth cap fires (DelegationDepthError) and cycle is refused (DelegationCycleError)', async () => {
    const leaf = pipeline({
      id: 'leaf',
      steps: [code({ id: 'noop', run: () => 'leaf' })],
    })
    const mid = pipeline({
      id: 'mid',
      steps: [
        code({
          id: 'go-deeper',
          permissions: { delegation: ['leaf'] },
          run: (ctx) => ctx.workflows?.invoke({ pipelineId: 'leaf' }),
        }),
      ],
    })
    const top = pipeline({
      id: 'top',
      steps: [
        code({
          id: 'go',
          permissions: { delegation: ['mid', 'leaf'] },
          run: (ctx) => ctx.workflows?.invoke({ pipelineId: 'mid' }),
        }),
      ],
    })
    const registry = registryOf({ leaf, mid, top })
    const depthRun = await runPipeline(top, undefined, {
      pipelineRegistry: registry,
      maxDelegationDepth: 1,
    })
    // The mid pipeline's own invoke exceeds the depth cap, so mid fails and
    // top's envelope reports the failure.
    expect(depthRun.status).toBe('completed')
    const envelope = depthRun.output as WorkflowInvokeResult
    expect(envelope.status).toBe('failed')
    expect(envelope.error?.name).toBe('DelegationDepthError')

    const loopy: Pipeline = pipeline({
      id: 'loopy',
      steps: [
        code({
          id: 'self',
          permissions: { delegation: ['loopy'] },
          run: (ctx) => ctx.workflows?.invoke({ pipelineId: 'loopy' }),
        }),
      ],
    })
    const cycleRun = await runPipeline(loopy, undefined, {
      pipelineRegistry: registryOf({ loopy }),
    })
    expect(cycleRun.status).toBe('failed')
    expect(cycleRun.error?.name).toBe('DelegationCycleError')
  })
})

describe('ctx.workflows.fanout — ceiling bounding (adversarial)', () => {
  it('every fanout child is intersected with the calling step policy', async () => {
    const captured: ResolvedPolicy[] = []
    const backends = new BackendRegistry()
    backends.register({
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
        if (req.permissions !== undefined) captured.push(req.permissions)
        return { text: 'ok' }
      },
    })
    const greedy = greedyChild()
    const parent = pipeline({
      id: 'parent-fanout',
      steps: [
        code({
          id: 'orchestrate',
          permissions: parentGrants,
          run: (ctx) =>
            ctx.workflows?.fanout({ pipelineId: 'greedy', inputs: [1, 2], strategy: 'wait-all' }),
        }),
      ],
    })
    const run = await runPipeline(parent, undefined, {
      backends,
      pipelineRegistry: registryOf({ greedy }),
    })
    expect(run.status).toBe('completed')
    expect(captured).toHaveLength(2)
    for (const policy of captured) assertIntersection(policy)
  })

  it('default-deny: fanout without a delegation grant is refused', async () => {
    const greedy = greedyChild()
    const parent = pipeline({
      id: 'parent-fanout-denied',
      steps: [
        code({
          id: 'orchestrate',
          run: (ctx) => ctx.workflows?.fanout({ pipelineId: 'greedy', inputs: [1] }),
        }),
      ],
    })
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ greedy }),
    })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
  })
})

describe('ctx.tasks.spawn — detached children are still ceiling-bound (adversarial)', () => {
  it('default-deny: a step with no delegation grant cannot spawn a task', async () => {
    const greedy = greedyChild()
    const parent = pipeline({
      id: 'parent-spawn-denied',
      steps: [
        code({
          id: 'orchestrate',
          run: (ctx) => ctx.tasks?.spawn({ workflowId: 'greedy' }),
        }),
      ],
    })
    const run = await runPipeline(parent, undefined, {
      pipelineRegistry: registryOf({ greedy }),
      store: new MemoryRunStore(),
    })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
  })

  it('a spawned task child gets the intersection — detachment is not an escape hatch', async () => {
    const sink: { policy?: ResolvedPolicy } = {}
    const backends = new BackendRegistry()
    backends.register(capturingBackend(sink))
    const greedy = greedyChild()
    const parent = pipeline({
      id: 'parent-spawn',
      steps: [
        code({
          id: 'orchestrate',
          permissions: parentGrants,
          run: async (ctx) => {
            const handle = await ctx.tasks?.spawn({ workflowId: 'greedy' })
            if (handle === undefined) throw new Error('tasks handle missing')
            await ctx.tasks?.wait(handle.taskId)
            return handle
          },
        }),
      ],
    })
    const run = await runPipeline(parent, undefined, {
      backends,
      pipelineRegistry: registryOf({ greedy }),
      store: new MemoryRunStore(),
    })
    expect(run.status).toBe('completed')
    expect(sink.policy).toBeDefined()
    assertIntersection(sink.policy as ResolvedPolicy)
  })
})
