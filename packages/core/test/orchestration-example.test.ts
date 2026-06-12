import { describe, expect, it } from 'vitest'
// The runnable example under examples/orchestration is the documentation for
// ctx.workflows; this test keeps it honest by actually running it.
import scan from '../../../examples/orchestration/scan.workflow.mts'
import summary from '../../../examples/orchestration/summary.workflow.mts'
import triage from '../../../examples/orchestration/triage.workflow.mts'
import { runPipeline } from '../src/runner.js'
import type { Pipeline } from '../src/types.js'

const registry = new Map<string, Pipeline>([
  [scan.id, scan as Pipeline],
  [summary.id, summary as Pipeline],
  [triage.id, triage as Pipeline],
])

describe('examples/orchestration', () => {
  it('triage invokes the summary child and fans out scans (best-effort)', async () => {
    const run = await runPipeline(
      triage as Pipeline,
      { reports: ['all good', 'error: disk full\nerror: again', 'corrupt blob'] },
      { pipelineRegistry: (id) => registry.get(id) },
    )
    expect(run.status).toBe('completed')
    const output = run.output as {
      title: string
      totalErrors: number
      scanned: number
      unreadable: number
    }
    expect(output.title).toBe('Triage of 3 report(s)')
    expect(output.totalErrors).toBe(2)
    expect(output.scanned).toBe(2)
    expect(output.unreadable).toBe(1)
  })

  it('refuses to run the children without the delegation grant (ceiling intact)', async () => {
    const stripped: Pipeline = {
      ...(triage as Pipeline),
      steps: (triage as Pipeline).steps.map((step) =>
        step.kind === 'code' ? { ...step, permissions: undefined } : step,
      ) as Pipeline['steps'],
    }
    const run = await runPipeline(
      stripped,
      { reports: ['all good'] },
      { pipelineRegistry: (id) => registry.get(id) },
    )
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
  })
})
