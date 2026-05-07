import { agent, pipeline } from '@skelm/core'
import { z } from 'zod'

export default pipeline({
  id: 'greet',
  description: 'Greet someone using a Vercel AI SDK model.',
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ greeting: z.string() }),
  steps: [
    agent({
      id: 'greet',
      backend: 'vercel-ai',
      prompt: (ctx) =>
        `Greet ${(ctx.input as { name: string }).name} warmly in one short sentence. Reply ONLY with JSON of the form {"greeting":"..."}.`,
      permissions: {
        allowedTools: [],
        allowedExecutables: [],
        allowedMcpServers: [],
        allowedSkills: [],
        fsRead: [],
        fsWrite: [],
        networkEgress: 'deny',
      },
      output: z.object({ greeting: z.string() }),
      maxTurns: 1,
    }),
  ],
})
