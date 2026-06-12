import { type WorkflowFanoutResult, type WorkflowInvokeResult, code, pipeline } from '@skelm/core'

interface TriageInput {
  reports: string[]
}

interface Header {
  title: string
  startedAt: string
}

interface ScanResult {
  report: string
  errors: number
}

/**
 * Parent workflow demonstrating in-workflow orchestration:
 *
 *  1. `ctx.workflows.invoke` runs the `orchestration-summary` child
 *     synchronously and adopts its output.
 *  2. `ctx.workflows.fanout` scans every report concurrently (best-effort:
 *     corrupt reports are recorded as failures, the rest still complete).
 *
 * The step's `permissions.delegation` allowlist is what authorizes both —
 * orchestration targets are default-denied without it. Every child runs under
 * this step's resolved policy as its permission ceiling: a child can declare
 * more, but it only ever GETS the intersection.
 *
 *   skelm run triage.workflow.mts --input '{"reports":["ok line","error: disk"]}'
 */
export default pipeline({
  id: 'orchestration-triage',
  description: 'Invokes a summary child, then fans out report scans.',
  steps: [
    code({
      id: 'orchestrate',
      permissions: {
        // Default-deny: only these two child workflows may be started here.
        delegation: ['orchestration-summary', 'orchestration-scan'],
      },
      run: async (ctx) => {
        const { reports } = ctx.input as TriageInput
        if (ctx.workflows === undefined) throw new Error('workflow orchestration not wired')

        const header: WorkflowInvokeResult<Header> = await ctx.workflows.invoke({
          pipelineId: 'orchestration-summary',
          input: { count: reports.length },
        })
        if (header.status !== 'completed' || header.output === undefined) {
          throw new Error(`summary child did not complete: ${header.error?.message}`)
        }

        const scans: WorkflowFanoutResult<ScanResult> = await ctx.workflows.fanout({
          pipelineId: 'orchestration-scan',
          inputs: reports,
          strategy: 'best-effort',
          concurrency: 2,
        })

        return {
          title: header.output.title,
          startedAt: header.output.startedAt,
          totalErrors: scans.successes.reduce((sum, scan) => sum + (scan.output?.errors ?? 0), 0),
          scanned: scans.successes.length,
          unreadable: scans.failures.length,
        }
      },
    }),
  ],
})
