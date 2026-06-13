import { type Context, code, pipeline } from '@skelm/core'
import { runSubagents } from '../src/index.js'

interface ChildOutput {
  role: string
  text: string
  score: number
}

/**
 * Package self-test: runs the research/coding/review recipe end-to-end across
 * three deterministic subagents and ranks the merged results by score. The
 * step's `permissions.delegation` allowlist authorizes the child workflow id —
 * orchestration is default-denied without it, and every child is
 * permission-ceiling-bound by this step. Run with the package's workflows
 * registered so `ctx.workflows` can resolve the child id.
 */
export default pipeline({
  id: 'subagent-orchestrator-selftest',
  description: 'Fans research subagents out end-to-end and ranks the merged results.',
  steps: [
    code({
      id: 'orchestrate',
      permissions: {
        delegation: ['subagent-orchestrator-selftest-child'],
      },
      run: async (ctx: Context) => {
        const child = 'subagent-orchestrator-selftest-child'
        const merged = await runSubagents<{ text: string; score: number }, ChildOutput>(ctx, {
          role: 'research',
          strategy: 'ranked-merge',
          concurrency: 2,
          rank: (a, b) => (b.output?.score ?? 0) - (a.output?.score ?? 0),
          children: [
            { workflowId: child, input: { text: 'alpha', score: 1 } },
            { workflowId: child, input: { text: 'beta', score: 3 } },
            { workflowId: child, input: { text: 'gamma', score: 2 } },
          ],
        })
        return {
          status: merged.status,
          ranked: merged.successes.map((s) => s.output?.text),
          lineage: merged.lineage.length,
          parentRunId: merged.parentRunId,
        }
      },
    }),
  ],
})
