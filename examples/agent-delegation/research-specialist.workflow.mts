import { agent, pipeline } from '@skelm/core'
import { z } from 'zod'

/**
 * A specialist agent the router delegates to. A one-agent pipeline IS a named
 * agent as far as delegation is concerned — `delegate` resolves it by this id.
 * It declares its own (narrow) permissions; whatever the router grants is
 * intersected on top, so the specialist can only ever have less.
 */
export default pipeline({
  id: 'research-specialist',
  description: 'Answers focused research questions in a few sentences.',
  input: z.object({ question: z.string().min(1) }),
  steps: [
    agent({
      id: 'answer',
      backend: 'agent',
      prompt: (ctx) =>
        `You are a research specialist. Answer this question concisely (2-3 sentences), then stop:\n\n${(ctx.input as { question: string }).question}`,
      permissions: { networkEgress: 'allow' },
      maxTurns: 2,
    }),
  ],
})
