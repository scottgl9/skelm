import { describe, expect, it } from 'vitest'
import {
  type WorkflowGraph,
  agent,
  branch,
  code,
  deriveWorkflowGraph,
  forEach,
  idempotent,
  infer,
  invoke,
  loop,
  parallel,
  persistentWorkflow,
  pipeline,
  pipelineStep,
  wait,
} from '../src/index.js'

// A nested pipeline used by pipelineStep().
const nested = pipeline({
  id: 'nested',
  steps: [code({ id: 'inner', run: () => 1 })],
})

// A fixture exercising every step kind, including nested control flow and a
// step that declares permissions (to assert redaction).
function buildFixture() {
  return pipeline({
    id: 'every-kind',
    version: '2.0.0',
    steps: [
      code({ id: 'inline', run: () => 1 }),
      code({ id: 'fromModule', module: './step.ts', export: 'handler' }),
      infer({ id: 'classify', backend: 'openai', model: 'gpt-x', prompt: 'p' }),
      agent({
        id: 'do-work',
        prompt: 'go',
        backend: 'claude',
        maxTurns: 5,
        permissions: {
          profile: 'reviewer',
          allowedTools: ['gh.list_issues'],
          allowedExecutables: ['git'],
          executableProfiles: ['ci-tools'],
          allowedSecrets: ['GITHUB_TOKEN'],
          networkEgress: { allowHosts: ['api.github.com'] },
          fsWrite: ['/work'],
        },
      }),
      parallel({
        id: 'fan-out',
        waitFor: 'all',
        steps: [code({ id: 'left', run: () => 'l' }), code({ id: 'right', run: () => 'r' })],
      }),
      branch({
        id: 'route',
        on: (ctx) => (ctx.input as { mode: string }).mode,
        cases: {
          fast: code({ id: 'fast-path', run: () => 'f' }),
          slow: code({ id: 'slow-path', run: () => 's' }),
        },
        default: code({ id: 'default-path', run: () => 'd' }),
      }),
      forEach({
        id: 'each',
        items: () => [1, 2, 3],
        step: (item) => code({ id: `item-${item}`, run: () => item }),
      }),
      loop({
        id: 'retry',
        maxIterations: 4,
        while: () => false,
        step: code({ id: 'loop-body', run: () => 1 }),
      }),
      wait({ id: 'approve', message: 'go ahead?', timeoutMs: 1000 }),
      pipelineStep({ id: 'sub', pipeline: nested }),
      invoke({ id: 'call', pipelineId: 'other-workflow' }),
      idempotent({ id: 'once', key: 'k1', step: code({ id: 'guarded', run: () => 1 }) }),
    ],
    finalize: () => ({ done: true }),
  })
}

function nodeById(graph: WorkflowGraph, id: string) {
  const node = graph.nodes.find((n) => n.id === id)
  if (node === undefined) throw new Error(`node not found: ${id}`)
  return node
}

describe('deriveWorkflowGraph', () => {
  it('derives a pipeline graph covering every step kind', () => {
    const graph = deriveWorkflowGraph(buildFixture())

    expect(graph.id).toBe('every-kind')
    expect(graph.version).toBe('2.0.0')
    expect(graph.kind).toBe('pipeline')
    expect(graph.meta).toEqual({ hasFinalize: true })

    const kinds = graph.nodes.map((n) => n.kind)
    expect(kinds).toEqual([
      'code',
      'code',
      'infer',
      'agent',
      'parallel',
      'branch',
      'forEach',
      'loop',
      'wait',
      'pipelineStep',
      'invoke',
      'idempotent',
    ])

    // Sequential control edges between top-level nodes.
    expect(graph.edges).toHaveLength(graph.nodes.length - 1)
    expect(graph.edges.every((e) => e.kind === 'control')).toBe(true)
    expect(graph.edges[0]).toEqual({ from: 'inline', to: 'fromModule', kind: 'control' })
  })

  it('flags codeOwned regions and module-backed code', () => {
    const graph = deriveWorkflowGraph(buildFixture())
    expect(nodeById(graph, 'inline').codeOwned).toBe(true)
    // A module reference is a stable path the editor can preserve.
    expect(nodeById(graph, 'fromModule').codeOwned).toBeUndefined()
    expect(nodeById(graph, 'fromModule').data).toEqual({
      module: './step.ts',
      export: 'handler',
    })
    // Control flow with author predicates / factories is code-owned.
    expect(nodeById(graph, 'route').codeOwned).toBe(true)
    expect(nodeById(graph, 'each').codeOwned).toBe(true)
    expect(nodeById(graph, 'retry').codeOwned).toBe(true)
  })

  it('nests children for control-flow containers with case labels', () => {
    const graph = deriveWorkflowGraph(buildFixture())

    const fanOut = nodeById(graph, 'fan-out')
    expect(fanOut.children?.map((c) => c.id)).toEqual(['left', 'right'])
    expect(fanOut.data).toEqual({ waitFor: 'all' })

    const route = nodeById(graph, 'route')
    expect(route.children?.map((c) => c.data?.case)).toEqual(['fast', 'slow', 'default'])
    expect(route.children?.map((c) => c.id)).toEqual(['fast-path', 'slow-path', 'default-path'])

    const retry = nodeById(graph, 'retry')
    expect(retry.children?.map((c) => c.id)).toEqual(['loop-body'])
    expect(retry.data).toEqual({ maxIterations: 4 })

    const sub = nodeById(graph, 'sub')
    expect(sub.children?.map((c) => c.id)).toEqual(['inner'])
    expect(sub.data).toEqual({ pipelineId: 'nested' })

    const once = nodeById(graph, 'once')
    expect(once.children?.map((c) => c.id)).toEqual(['guarded'])
    expect(once.data).toEqual({ key: 'k1' })
  })

  it('carries kind-specific data without functions', () => {
    const graph = deriveWorkflowGraph(buildFixture())
    expect(nodeById(graph, 'classify').data).toEqual({ backend: 'openai', model: 'gpt-x' })
    expect(nodeById(graph, 'approve').data).toEqual({ message: 'go ahead?', timeoutMs: 1000 })
    expect(nodeById(graph, 'call').data).toEqual({ pipelineId: 'other-workflow' })
  })

  it('redacts permissions to dimension + profile names only', () => {
    const graph = deriveWorkflowGraph(buildFixture())
    const perms = nodeById(graph, 'do-work').permissions
    expect(perms).toBeDefined()
    expect(perms?.dimensions).toEqual(['tool', 'executable', 'secret', 'network', 'fs.write'])
    expect(perms?.profile).toBe('reviewer')
    expect(perms?.executableProfiles).toEqual(['ci-tools'])
  })

  it('never leaks a function or secret value into the JSON', () => {
    const graph = deriveWorkflowGraph(buildFixture())
    const json = JSON.stringify(graph)
    // Round-trips cleanly.
    expect(JSON.parse(json)).toEqual(graph)
    // No function markers.
    expect(json).not.toContain('[Function]')
    expect(json).not.toMatch(/=>/)
    expect(json).not.toContain('function')
    // No secret values (allowlisted names like GITHUB_TOKEN are redacted away,
    // only dimension labels remain) and no host/path operational surface.
    expect(json).not.toContain('GITHUB_TOKEN')
    expect(json).not.toContain('api.github.com')
    expect(json).not.toContain('/work')
    expect(json).not.toContain('gh.list_issues')
  })

  it('is deterministic: same workflow yields an identical graph', () => {
    const a = deriveWorkflowGraph(buildFixture())
    const b = deriveWorkflowGraph(buildFixture())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('derives a persistent-workflow graph: preamble steps + terminal turn', () => {
    const wf = persistentWorkflow({
      id: 'assistant',
      steps: [code({ id: 'enrich', run: () => ({ x: 1 }) })],
      agent: {
        backend: 'claude',
        maxTurns: 3,
        sessionKey: (p: { chatId: string }) => p.chatId,
        permissions: { allowedTools: ['*'] },
      },
    })
    const graph = deriveWorkflowGraph(wf)
    expect(graph.kind).toBe('persistent-workflow')
    expect(graph.nodes.map((n) => n.id)).toEqual(['enrich', 'turn'])
    const turn = nodeById(graph, 'turn')
    expect(turn.kind).toBe('agent')
    expect(turn.data).toEqual({ backend: 'claude', maxTurns: 3 })
    expect(turn.permissions?.dimensions).toEqual(['tool'])
    expect(graph.edges).toEqual([{ from: 'enrich', to: 'turn', kind: 'control' }])
    // sessionKey is a function and must never serialize.
    expect(JSON.stringify(graph)).not.toContain('chatId')
  })
})
