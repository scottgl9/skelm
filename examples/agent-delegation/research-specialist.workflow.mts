import { agent, pipeline } from '@skelm/core'
import { z } from 'zod'

/**
 * A specialist agent the router delegates to. A one-agent pipeline IS a named
 * agent as far as delegation is concerned — `delegate` resolves it by this id.
 * It declares its own (narrow) permissions; whatever the router grants is
 * intersected on top, so the specialist can only ever have less.
 */
// Accept either a bare string or a { question } object — a delegating model
// may pass the input in either shape, so the specialist tolerates both.
const Input = z.union([z.string().min(1), z.object({ question: z.string().min(1) })])

export default pipeline({
  id: 'research-specialist',
  description: 'Answers focused research questions in a few sentences.',
  input: Input,
  steps: [
    agent({
      id: 'answer',
      backend: 'agent',
      prompt: (ctx) => {
        const input = ctx.input as z.infer<typeof Input>
        const question = typeof input === 'string' ? input : input.question
        return `You are a research specialist. Answer this question concisely (2-3 sentences), then stop:\n\n${question}`
      },
      permissions: { networkEgress: 'allow' },
      maxTurns: 2,
    }),
  ],
})
