import { code, pipeline } from '@skelm/core'
import { z } from 'zod'

export default pipeline({
  id: 'multi-step',
  description: 'Deterministic + (placeholder) LLM + (placeholder) agent steps',
  input: z.object({ task: z.string().min(1) }),
  output: z.object({
    task: z.string(),
    summary: z.string(),
    handoff: z.string(),
    report: z.string(),
  }),
  steps: [
    code({
      id: 'parse-input',
      run: (ctx) => {
        const t = (ctx.input as { task: string }).task.trim()
        return { task: t }
      },
    }),
    code({
      id: 'summarize',
      run: (ctx) => {
        const t = (ctx.steps['parse-input'] as { task: string }).task
        // Placeholder for `infer({ id: 'summarize', prompt: ... })`.
        return { summary: `One-line summary of: ${t}` }
      },
    }),
    code({
      id: 'dispatch-to-agent',
      run: (ctx) => {
        const t = (ctx.steps['parse-input'] as { task: string }).task
        // Placeholder for `agent({ id: 'opencode-1', prompt: ... })`.
        return { handoff: `would have asked opencode to investigate: ${t}` }
      },
    }),
    code({
      id: 'report',
      run: (ctx) => {
        const parse = ctx.steps['parse-input'] as { task: string }
        const sum = ctx.steps.summarize as { summary: string }
        const handoff = ctx.steps['dispatch-to-agent'] as { handoff: string }
        return {
          task: parse.task,
          summary: sum.summary,
          handoff: handoff.handoff,
          report: `${parse.task} — ${sum.summary} — ${handoff.handoff}`,
        }
      },
    }),
  ],
})
