import { agent, pipeline } from '@skelm/core'
import { z } from 'zod'

/**
 * A router agent that hands research questions off to the research-specialist
 * via the built-in `delegate` tool. The `delegation` allowlist is default-deny:
 * the router may ONLY delegate to the ids listed here, and the specialist runs
 * with at most the router's own permissions.
 */
export default pipeline({
  id: 'router',
  description: 'Routes research questions to a specialist agent via delegation.',
  input: z.object({ message: z.string().min(1) }),
  steps: [
    agent({
      id: 'route',
      backend: 'agent',
      prompt: (ctx) =>
        [
          'You are a router. For any research question, do NOT answer it yourself.',
          'Instead call the `delegate` tool with agentId "research-specialist" and',
          'input { "question": <the question> }. Then report the specialist\'s answer',
          'to the user verbatim, prefixed with "Specialist says: ".',
          '',
          `User message: ${(ctx.input as { message: string }).message}`,
        ].join('\n'),
      permissions: {
        allowedTools: ['*'],
        // Default-deny: the router may delegate ONLY to this id.
        delegation: ['research-specialist'],
        networkEgress: 'allow',
      },
      maxTurns: 4,
    }),
  ],
})
