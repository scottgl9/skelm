import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentRequest,
  type AgentResponse,
  type BackendContext,
  type GraphEdit,
  type SkelmBackend,
  code,
  pipeline,
} from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowBuilder } from '../src/builder.js'
import { createProjectSource } from '../src/project.js'
import type { ApplyRoute, ReviewablePatch, ValidationOutcome } from '../src/types.js'

const FIXTURE = `import { pipeline, code } from '@skelm/core'
export default pipeline({
  id: 'greet',
  steps: [code({ id: 'hello', module: './steps.js' })],
})
`

function stubAgent(opts?: {
  reply?: string
  onRun?: (req: AgentRequest, ctx: BackendContext) => void
  noRun?: boolean
}): SkelmBackend {
  const b: SkelmBackend = {
    id: 'stub-agent',
    capabilities: {
      prompt: true,
      streaming: false,
      sessionLifecycle: false,
      mcp: false,
      skills: false,
      modelSelection: false,
      toolPermissions: 'unsupported',
    },
  }
  if (!opts?.noRun) {
    b.run = async (req: AgentRequest, ctx: BackendContext): Promise<AgentResponse> => {
      opts?.onRun?.(req, ctx)
      return { text: opts?.reply ?? 'done' }
    }
  }
  return b
}

function recordingApplyRoute(): { route: ApplyRoute; calls: { dryRun: boolean }[] } {
  const calls: { dryRun: boolean }[] = []
  const route: ApplyRoute = {
    async deriveGraph() {
      return { id: 'greet', kind: 'pipeline', nodes: [], edges: [] }
    },
    async applyEdits(_id, _edits: readonly GraphEdit[], options): Promise<ReviewablePatch> {
      const dryRun = options?.dryRun !== false
      calls.push({ dryRun })
      return { ok: true, applied: !dryRun, dryRun, diff: '--- a\n+++ b\n@@ @@\n' }
    },
  }
  return { route, calls }
}

const passingValidate = async (path: string): Promise<ValidationOutcome> => ({
  valid: true,
  stdout: `validated ${path}`,
  stderr: '',
  exitCode: 0,
})

describe('WorkflowBuilder', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skelm-wfb-'))
    await mkdir(join(root, 'workflows'), { recursive: true })
    await writeFile(join(root, 'workflows', 'greet.workflow.ts'), FIXTURE, 'utf8')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('inspects workflows: reads source and derives the graph', async () => {
    const { route } = recordingApplyRoute()
    const builder = new WorkflowBuilder({
      project: createProjectSource(root),
      applyRoute: route,
      validate: passingValidate,
      agent: stubAgent(),
    })
    const inspected = await builder.inspect(async (path) =>
      pipeline({ id: 'greet', steps: [code({ id: 'hello', module: './steps.js' })] }),
    )
    expect(inspected).toHaveLength(1)
    expect(inspected[0]?.id).toBe('greet')
    expect(inspected[0]?.source).toContain("id: 'greet'")
    expect(inspected[0]?.relativePath).toBe('workflows/greet.workflow.ts')
    expect(inspected[0]?.graph.kind).toBe('pipeline')
    expect(inspected[0]?.graph.nodes.map((n) => n.id)).toContain('hello')
  })

  it('proposes edits as a dry-run reviewable patch by default (never auto-writes)', async () => {
    const { route, calls } = recordingApplyRoute()
    const builder = new WorkflowBuilder({
      project: createProjectSource(root),
      applyRoute: route,
      validate: passingValidate,
      agent: stubAgent(),
    })
    const patch = await builder.proposeEdits('greet', [
      { kind: 'setStepField', stepId: 'hello', field: 'timeoutMs', value: 1000 },
    ])
    expect(calls).toEqual([{ dryRun: true }])
    expect(patch.dryRun).toBe(true)
    expect(patch.applied).toBe(false)
    expect(patch.diff).toContain('@@')
  })

  it('only writes when a caller explicitly opts into dryRun: false', async () => {
    const { route, calls } = recordingApplyRoute()
    const builder = new WorkflowBuilder({
      project: createProjectSource(root),
      applyRoute: route,
      validate: passingValidate,
      agent: stubAgent(),
    })
    const patch = await builder.proposeEdits('greet', [{ kind: 'removeStep', stepId: 'hello' }], {
      dryRun: false,
    })
    expect(calls).toEqual([{ dryRun: false }])
    expect(patch.applied).toBe(true)
    expect(patch.dryRun).toBe(false)
  })

  it('surfaces a code-owned refusal as a non-applied patch', async () => {
    const route: ApplyRoute = {
      async deriveGraph() {
        return { id: 'greet', kind: 'pipeline', nodes: [], edges: [] }
      },
      async applyEdits() {
        return {
          ok: false,
          applied: false,
          dryRun: true,
          reason: 'code-owned',
          detail: 'inline run cannot be rewritten',
        }
      },
    }
    const builder = new WorkflowBuilder({
      project: createProjectSource(root),
      applyRoute: route,
      validate: passingValidate,
      agent: stubAgent(),
    })
    const patch = await builder.proposeEdits('greet', [
      { kind: 'setStepField', stepId: 'hello', field: 'run', value: 1 } as unknown as GraphEdit,
    ])
    expect(patch.ok).toBe(false)
    expect(patch.applied).toBe(false)
    expect(patch.reason).toBe('code-owned')
  })

  it('runs validate on a candidate workflow', async () => {
    let seen = ''
    const builder = new WorkflowBuilder({
      project: createProjectSource(root),
      applyRoute: recordingApplyRoute().route,
      validate: async (p) => {
        seen = p
        return { valid: true, stdout: '', stderr: '', exitCode: 0 }
      },
      agent: stubAgent(),
    })
    const out = await builder.validateWorkflow(join(root, 'workflows', 'greet.workflow.ts'))
    expect(out.valid).toBe(true)
    expect(seen).toBe(join(root, 'workflows', 'greet.workflow.ts'))
  })

  it('drives a turn through the stubbed agent backend (no real LLM)', async () => {
    let prompt = ''
    const builder = new WorkflowBuilder({
      project: createProjectSource(root),
      applyRoute: recordingApplyRoute().route,
      validate: passingValidate,
      agent: stubAgent({
        reply: 'Proposed a reviewable patch.',
        onRun: (req) => {
          prompt = req.prompt as string
        },
      }),
    })
    const inventory = await builder.inspect(async () =>
      pipeline({ id: 'greet', steps: [code({ id: 'hello', module: './steps.js' })] }),
    )
    const reply = await builder.turn('rename the step', { inventory })
    expect(reply).toBe('Proposed a reviewable patch.')
    expect(prompt).toContain('greet')
    expect(prompt).toContain('rename the step')
  })

  it('refuses to author when the backend has no run() method', async () => {
    const builder = new WorkflowBuilder({
      project: createProjectSource(root),
      applyRoute: recordingApplyRoute().route,
      validate: passingValidate,
      agent: stubAgent({ noRun: true }),
    })
    await expect(builder.turn('x', { inventory: [] })).rejects.toThrow(/cannot author/)
  })

  it('generates a manifest mapping the first workflow to default', () => {
    const builder = new WorkflowBuilder({
      project: createProjectSource(root),
      applyRoute: recordingApplyRoute().route,
      validate: passingValidate,
      agent: stubAgent(),
    })
    const manifest = builder.generateManifest({
      name: '@acme/wf',
      version: '1.0.0',
      description: 'demo',
      workflows: [
        { entry: 'workflows/greet.workflow.ts' },
        { entry: 'workflows/other.workflow.ts', kind: 'persistent' },
      ],
    })
    const parsed = JSON.parse(manifest)
    expect(parsed.name).toBe('@acme/wf')
    expect(parsed.skelm.apiVersion).toBe(1)
    expect(parsed.skelm.workflows[0].id).toBe('default')
    expect(parsed.skelm.workflows[1].kind).toBe('persistent')
  })
})
