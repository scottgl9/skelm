import { code, pipeline } from '@skelm/core'
import { z } from 'zod'

/**
 * Demonstrates ctx.steps[id] propagating through a multi-step workflow:
 * compute two intermediate values in code() steps, sum them in a third,
 * and adopt the third step's output as the run output.
 */
export default pipeline({
  id: 'sum',
  description: 'Adds two numbers via three code steps.',
  input: z.object({ a: z.number(), b: z.number() }),
  output: z.object({ sum: z.number() }),
  steps: [
    code({
      id: 'a',
      run: (ctx) => ({ value: (ctx.input as { a: number }).a }),
    }),
    code({
      id: 'b',
      run: (ctx) => ({ value: (ctx.input as { b: number }).b }),
    }),
    code({
      id: 'sum',
      run: (ctx) => {
        const a = (ctx.steps.a as { value: number }).value
        const b = (ctx.steps.b as { value: number }).value
        return { sum: a + b }
      },
    }),
  ],
  finalize: (ctx) => ctx.steps.sum as { sum: number },
})
