// Package self-test for @skelm/workflow-builder.
//
// Runs the build/revise loop end-to-end against a tiny in-memory fixture project
// with a STUBBED agent backend — no real LLM, no live gateway. It proves the
// builder inspects workflows (source + derived graph), proposes an edit as a
// reviewable (dry-run) patch through a fake apply route, and runs validation.
// Exits non-zero on any failure so a self-test harness can gate on it.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { code, pipeline } from '@skelm/core'
import type { GraphEdit, SkelmBackend } from '@skelm/core'
import { WorkflowBuilder } from '../dist/builder.js'
import { createProjectSource } from '../dist/project.js'
import type { ApplyRoute, ReviewablePatch, ValidationOutcome } from '../dist/types.js'

const FIXTURE_WORKFLOW = `import { pipeline, code } from '@skelm/core'
export default pipeline({
  id: 'greet',
  steps: [code({ id: 'hello', module: './steps.js', export: 'hello' })],
})
`

function stubAgent(reply: string): SkelmBackend {
  return {
    id: 'stub-builder-agent',
    capabilities: {
      prompt: true,
      streaming: false,
      sessionLifecycle: false,
      mcp: false,
      skills: false,
      modelSelection: false,
      toolPermissions: 'unsupported',
    },
    async run() {
      return { text: reply }
    },
  }
}

function fakeApplyRoute(): ApplyRoute {
  return {
    async deriveGraph() {
      throw new Error('not used in self-test')
    },
    async applyEdits(_id, _edits: readonly GraphEdit[], opts): Promise<ReviewablePatch> {
      const dryRun = opts?.dryRun !== false
      return {
        ok: true,
        applied: false,
        dryRun,
        diff: '--- a/greet.workflow.ts\n+++ b/greet.workflow.ts\n@@ reviewable @@\n',
      }
    },
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'skelm-wfb-selftest-'))
  try {
    await mkdir(join(root, 'workflows'), { recursive: true })
    await writeFile(join(root, 'workflows', 'greet.workflow.ts'), FIXTURE_WORKFLOW, 'utf8')

    let validated = ''
    const validate = async (path: string): Promise<ValidationOutcome> => {
      validated = path
      return { valid: true, stdout: 'ok', stderr: '', exitCode: 0 }
    }

    const builder = new WorkflowBuilder({
      project: createProjectSource(root),
      applyRoute: fakeApplyRoute(),
      validate,
      agent: stubAgent('Proposed a reviewable patch for greet.workflow.ts.'),
    })

    // Inspect: read source + derive graph for the fixture workflow.
    const inventory = await builder.inspect(async () =>
      pipeline({ id: 'greet', steps: [code({ id: 'hello', module: './steps.js' })] }),
    )
    assert(inventory.length === 1, 'expected one inspected workflow')
    const inspected = inventory[0]
    assert(inspected !== undefined, 'expected one inspected workflow')
    assert(inspected?.id === 'greet', 'expected workflow id greet')
    assert(inspected?.graph.kind === 'pipeline', 'expected pipeline graph')

    // Turn: the stub agent replies; no LLM involved.
    const reply = await builder.turn('add a finalize step', { inventory })
    assert(reply.includes('reviewable patch'), 'expected agent reply')

    // Propose an edit as a dry-run reviewable patch.
    const edits: GraphEdit[] = [
      { kind: 'setStepField', stepId: 'hello', field: 'timeoutMs', value: 1000 },
    ]
    const patch = await builder.proposeEdits('greet', edits)
    assert(patch.dryRun === true, 'patch must be dry-run by default')
    assert(patch.applied === false, 'dry-run patch must not be applied')
    assert(typeof patch.diff === 'string', 'patch must carry a diff')

    // Validate the candidate.
    const outcome = await builder.validateWorkflow(inspected.path)
    assert(outcome.valid, 'validation must pass')
    assert(validated === inspected.path, 'validate must receive the workflow path')

    // Manifest generation.
    const manifest = builder.generateManifest({
      name: '@acme/greet',
      version: '0.1.0',
      workflows: [{ entry: 'workflows/greet.workflow.ts' }],
    })
    assert(manifest.includes('"id": "default"'), 'first workflow must map to default')

    process.stdout.write('workflow-builder self-test: OK\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    process.stderr.write(`workflow-builder self-test FAILED: ${message}\n`)
    process.exit(1)
  }
}

main().catch((err) => {
  process.stderr.write(`workflow-builder self-test ERROR: ${err?.message ?? err}\n`)
  process.exit(1)
})
