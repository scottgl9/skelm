import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { applyGraphEdits, deriveWorkflowGraph } from '../src/graph/index.js'
import type { GraphEdit, Pipeline } from '../src/index.js'

// Realistic fixture for AST-level assertions (never executed).
const SOURCE = `import { code, infer, invoke, pipeline, wait } from 'skelm'

export default pipeline({
  id: 'fixture',
  version: '1.0.0',
  steps: [
    code({
      id: 'prepare',
      run: (ctx) => ({ value: 1 + 1 }),
    }),
    infer({
      id: 'summarize',
      backend: 'local',
      model: 'llama-3',
      prompt: 'Summarize the value.',
    }),
    wait({
      id: 'approval',
      message: 'approve?',
      timeoutMs: 60000,
    }),
    invoke({
      id: 'downstream',
      pipelineId: 'other-pipeline',
    }),
  ],
})
`

const RUN_FN = '(ctx) => ({ value: 1 + 1 })'

function apply(source: string, edits: GraphEdit[]): { source: string; diff: string } {
  const result = applyGraphEdits(source, edits)
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`)
  return result
}

function refusal(source: string, edits: GraphEdit[]): { reason: string; detail: string } {
  const result = applyGraphEdits(source, edits)
  if (result.ok) throw new Error('expected refusal, got ok')
  return result
}

describe('applyGraphEdits', () => {
  it('reorders steps and round-trips back to the original source byte-for-byte', () => {
    const reordered = apply(SOURCE, [
      {
        kind: 'reorderSteps',
        pipelineId: 'fixture',
        orderedStepIds: ['summarize', 'prepare', 'approval', 'downstream'],
      },
    ])
    expect(reordered.source.indexOf("id: 'summarize'")).toBeLessThan(
      reordered.source.indexOf("id: 'prepare'"),
    )
    // codeOwned region relocated byte-identically
    expect(reordered.source).toContain(RUN_FN)
    expect(reordered.diff).toContain('@@')
    const restored = apply(reordered.source, [
      {
        kind: 'reorderSteps',
        pipelineId: 'fixture',
        orderedStepIds: ['prepare', 'summarize', 'approval', 'downstream'],
      },
    ])
    expect(restored.source).toBe(SOURCE)
  })

  it('rewrites an existing declarative field in place', () => {
    const result = apply(SOURCE, [
      { kind: 'setStepField', stepId: 'summarize', field: 'model', value: 'mistral-large' },
    ])
    expect(result.source).toContain("model: 'mistral-large'")
    expect(result.source).not.toContain("model: 'llama-3'")
    expect(result.source).toContain(RUN_FN)
    expect(result.diff).toContain("-      model: 'llama-3',")
    expect(result.diff).toContain("+      model: 'mistral-large',")
  })

  it('inserts a missing declarative field after the id property', () => {
    const result = apply(SOURCE, [
      { kind: 'setStepField', stepId: 'summarize', field: 'temperature', value: 0.2 },
    ])
    expect(result.source).toContain("id: 'summarize', temperature: 0.2")
  })

  it('adds a declarative step and augments the skelm import when needed', () => {
    const result = apply(SOURCE, [
      {
        kind: 'addStep',
        afterStepId: 'approval',
        step: { kind: 'agent', id: 'review', prompt: 'Review it.', maxTurns: 3 },
      },
    ])
    expect(result.source).toContain("agent({ id: 'review', prompt: 'Review it.', maxTurns: 3 })")
    expect(result.source).toContain(
      "import { code, infer, invoke, pipeline, wait, agent } from 'skelm'",
    )
    const approvalIdx = result.source.indexOf("id: 'approval'")
    const reviewIdx = result.source.indexOf("id: 'review'")
    const downstreamIdx = result.source.indexOf("id: 'downstream'")
    expect(reviewIdx).toBeGreaterThan(approvalIdx)
    expect(reviewIdx).toBeLessThan(downstreamIdx)
  })

  it('removes a fully declarative step', () => {
    const result = apply(SOURCE, [{ kind: 'removeStep', stepId: 'downstream' }])
    expect(result.source).not.toContain("id: 'downstream'")
    expect(result.source).toContain(RUN_FN)
    expect(result.source).toContain("id: 'approval'")
  })

  it('applies several edits in sequence', () => {
    const result = apply(SOURCE, [
      { kind: 'setStepField', stepId: 'approval', field: 'timeoutMs', value: 1000 },
      { kind: 'removeStep', stepId: 'downstream' },
      { kind: 'addStep', step: { kind: 'wait', id: 'final-gate', message: 'done?' } },
    ])
    expect(result.source).toContain('timeoutMs: 1000')
    expect(result.source).not.toContain('downstream')
    expect(result.source).toContain("wait({ id: 'final-gate', message: 'done?' })")
    expect(result.source).toContain(RUN_FN)
  })

  it('keeps a hostile string value inert as a single string literal', () => {
    const payload = "x'); process.exit(1); //\n${process.env.SECRET}"
    const result = apply(SOURCE, [
      { kind: 'setStepField', stepId: 'approval', field: 'message', value: payload },
    ])
    // Still exactly one author function, byte-identical: nothing was injected.
    expect(result.source).toContain(RUN_FN)
    expect(result.source).toContain("\\'); process.exit(1); //\\n")
    // And the emitted source still parses (applyGraphEdits would have refused otherwise).
    const again = apply(result.source, [
      { kind: 'setStepField', stepId: 'approval', field: 'message', value: 'plain' },
    ])
    expect(again.source).toContain("message: 'plain'")
  })

  describe('codeOwned refusal', () => {
    it('refuses setStepField on a code step with an inline run function', () => {
      const result = refusal(SOURCE, [
        { kind: 'setStepField', stepId: 'prepare', field: 'timeoutMs', value: 5 },
      ])
      expect(result.reason).toBe('code-owned')
    })

    it('refuses setting a code-owned field outright', () => {
      const result = refusal(SOURCE, [
        { kind: 'setStepField', stepId: 'summarize', field: 'run', value: 'x' },
      ])
      expect(result.reason).toBe('code-owned')
    })

    it('refuses removing a step that carries author code', () => {
      const result = refusal(SOURCE, [{ kind: 'removeStep', stepId: 'prepare' }])
      expect(result.reason).toBe('code-owned')
    })

    it('refuses edits on branch / loop / forEach steps', () => {
      const branchy = `import { branch, code, pipeline } from 'skelm'

export default pipeline({
  id: 'branchy',
  steps: [
    branch({
      id: 'route',
      on: (ctx) => 'a',
      cases: { a: code({ id: 'a-path', run: () => 1 }) },
    }),
  ],
})
`
      const result = refusal(branchy, [
        { kind: 'setStepField', stepId: 'route', field: 'backend', value: 'x' },
      ])
      expect(result.reason).toBe('code-owned')
      expect(refusal(branchy, [{ kind: 'removeStep', stepId: 'route' }]).reason).toBe('code-owned')
    })
  })

  describe('unsupported / invalid refusal', () => {
    it('refuses an unknown edit kind', () => {
      const result = refusal(SOURCE, [{ kind: 'renamePipeline' } as unknown as GraphEdit])
      expect(result.reason).toBe('unsupported')
    })

    it('refuses an empty edit list', () => {
      expect(refusal(SOURCE, []).reason).toBe('unsupported')
    })

    it('refuses a field outside the per-kind whitelist', () => {
      const result = refusal(SOURCE, [
        { kind: 'setStepField', stepId: 'summarize', field: 'retry', value: 3 },
      ])
      expect(result.reason).toBe('unsupported')
    })

    it('refuses renaming a step id', () => {
      const result = refusal(SOURCE, [
        { kind: 'setStepField', stepId: 'approval', field: 'id', value: 'renamed' },
      ])
      expect(result.reason).toBe('unsupported')
    })

    it('refuses a non-JSON value', () => {
      const result = refusal(SOURCE, [
        {
          kind: 'setStepField',
          stepId: 'approval',
          field: 'message',
          value: (() => 'evil') as unknown as string,
        },
      ])
      expect(result.reason).toBe('unsupported')
    })

    it('refuses a declarative spec smuggling a run field', () => {
      const result = refusal(SOURCE, [
        {
          kind: 'addStep',
          step: {
            kind: 'code',
            id: 'smuggle',
            module: './x.js',
            run: '() => evil()',
          } as unknown as Extract<GraphEdit, { kind: 'addStep' }>['step'],
        },
      ])
      expect(result.reason).toBe('unsupported')
    })

    it('refuses an addStep spec for a non-declarative kind', () => {
      const result = refusal(SOURCE, [
        {
          kind: 'addStep',
          step: { kind: 'branch', id: 'b' } as unknown as Extract<
            GraphEdit,
            { kind: 'addStep' }
          >['step'],
        },
      ])
      expect(result.reason).toBe('unsupported')
    })

    it('refuses a reorder that is not a permutation', () => {
      const result = refusal(SOURCE, [
        { kind: 'reorderSteps', pipelineId: 'fixture', orderedStepIds: ['prepare', 'summarize'] },
      ])
      expect(result.reason).toBe('unsupported')
    })

    it('refuses a duplicate step id on addStep', () => {
      const result = refusal(SOURCE, [{ kind: 'addStep', step: { kind: 'wait', id: 'approval' } }])
      expect(result.reason).toBe('unsupported')
    })

    it('reports unknown step / pipeline ids as not-found', () => {
      expect(refusal(SOURCE, [{ kind: 'removeStep', stepId: 'ghost' }]).reason).toBe('not-found')
      expect(
        refusal(SOURCE, [{ kind: 'setStepField', stepId: 'ghost', field: 'message', value: 'x' }])
          .reason,
      ).toBe('not-found')
      expect(
        refusal(SOURCE, [{ kind: 'reorderSteps', pipelineId: 'ghost', orderedStepIds: ['a'] }])
          .reason,
      ).toBe('not-found')
    })

    it('refuses reordering across comments it cannot preserve', () => {
      const commented = SOURCE.replace('    invoke({', '    // important: keep last\n    invoke({')
      const result = refusal(commented, [
        {
          kind: 'reorderSteps',
          pipelineId: 'fixture',
          orderedStepIds: ['downstream', 'prepare', 'summarize', 'approval'],
        },
      ])
      expect(result.reason).toBe('unsupported')
    })

    it('rejects source that does not parse', () => {
      expect(
        refusal('export default pipeline({', [{ kind: 'removeStep', stepId: 'x' }]).reason,
      ).toBe('invalid-source')
    })
  })
})

describe('applyGraphEdits → executable round-trip', () => {
  // Self-contained fixture with local builder shims so the emitted source can
  // be imported by Node directly (no package resolution from a temp dir).
  const EXEC_SOURCE = `type Def = Record<string, unknown>
const pipeline = (def: Def) => def
const wait = (def: Def) => ({ kind: 'wait', ...def })
const invoke = (def: Def) => ({ kind: 'invoke', ...def })
const infer = (def: Def) => ({ kind: 'infer', ...def })
const code = (def: Def) => ({ kind: 'code', ...def })

export default pipeline({
  id: 'exec-fixture',
  steps: [
    wait({ id: 'gate', message: 'ok?', timeoutMs: 60000 }),
    infer({ id: 'think', backend: 'local', model: 'm1', prompt: 'p' }),
    invoke({ id: 'child', pipelineId: 'other' }),
  ],
})
`
  let dir: string | undefined

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  })

  it('emits source whose loaded module derives the expected graph', async () => {
    const result = apply(EXEC_SOURCE, [
      {
        kind: 'reorderSteps',
        pipelineId: 'exec-fixture',
        orderedStepIds: ['think', 'gate', 'child'],
      },
      { kind: 'setStepField', stepId: 'gate', field: 'timeoutMs', value: 1500 },
      { kind: 'removeStep', stepId: 'child' },
      { kind: 'addStep', afterStepId: 'gate', step: { kind: 'wait', id: 'second-gate' } },
    ])
    dir = await mkdtemp(join(tmpdir(), 'skelm-roundtrip-'))
    const file = join(dir, 'emitted.workflow.mts')
    await writeFile(file, result.source, 'utf8')
    const mod = (await import(pathToFileURL(file).href)) as { default: Pipeline }
    const graph = deriveWorkflowGraph(mod.default)
    expect(graph.id).toBe('exec-fixture')
    expect(graph.nodes.map((n) => n.id)).toEqual(['think', 'gate', 'second-gate'])
    expect(graph.nodes[1]?.data?.timeoutMs).toBe(1500)
    expect(graph.edges).toEqual([
      { from: 'think', to: 'gate', kind: 'control' },
      { from: 'gate', to: 'second-gate', kind: 'control' },
    ])
  })
})
