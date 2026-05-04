import { code, pipeline } from '@skelm/core'
import { z } from 'zod'

/**
 * Single-agent workflow triggered by a Matrix message.
 *
 * The actual `agent()` step is intentionally simulated as a `code()`
 * step in this fixture so the example runs without an installed coding
 * agent. Replace the body with `agent({ id: 'claude-code', ... })`
 * once you have an ephemeral agent declared in skelm.config.ts.
 */
export default pipeline({
  id: 'matrix-coding-agent',
  description: 'Run a one-shot coding task per incoming Matrix message',
  input: z.object({
    message: z.string().min(1),
    room: z.string().min(1),
  }),
  output: z.object({
    summary: z.string(),
    room: z.string(),
  }),
  steps: [
    code({
      id: 'dispatch',
      run: (ctx) => {
        const input = ctx.input as { message: string; room: string }
        // In production this is `agent({ id: 'claude-code', prompt: input.message })`.
        return {
          summary: `would have asked claude-code: ${input.message}`,
          room: input.room,
        }
      },
    }),
  ],
})
