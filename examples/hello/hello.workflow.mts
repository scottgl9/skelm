import { code, pipeline } from '@skelm/core'
import { z } from 'zod'

export default pipeline({
  id: 'hello',
  description: 'Greets someone by name.',
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ greeting: z.string() }),
  steps: [
    code({
      id: 'greet',
      run: (ctx) => ({ greeting: `hello, ${(ctx.input as { name: string }).name}` }),
    }),
  ],
})
