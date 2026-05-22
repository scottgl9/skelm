import { branch, code, forEach, loop, parallel, pipeline } from '@skelm/core'
import { z } from 'zod'

/** Fixture for testing `skelm describe --format mermaid`. Covers all structural step kinds. */
export default pipeline({
  id: 'control-flow',
  description: 'Covers parallel, forEach, branch, and loop for mermaid rendering.',
  input: z.object({ mode: z.string() }),
  output: z.object({ done: z.boolean() }),
  steps: [
    parallel({
      id: 'fan-out',
      steps: [
        code({ id: 'left', run: () => ({ side: 'left' }) }),
        code({ id: 'right', run: () => ({ side: 'right' }) }),
      ],
    }),
    forEach({
      id: 'each-item',
      items: () => [1, 2, 3],
      step: (item) => code({ id: `item-${item}`, run: () => ({ item }) }),
    }),
    branch({
      id: 'route',
      on: (ctx) => (ctx.input as { mode: string }).mode,
      cases: {
        fast: code({ id: 'fast-path', run: () => ({ speed: 'fast' }) }),
        slow: code({ id: 'slow-path', run: () => ({ speed: 'slow' }) }),
      },
      default: code({ id: 'default-path', run: () => ({ speed: 'default' }) }),
    }),
    loop({
      id: 'retry-loop',
      maxIterations: 3,
      while: () => false,
      step: code({ id: 'loop-body', run: () => ({ attempt: 1 }) }),
    }),
    code({
      id: 'finish',
      run: () => ({ done: true }),
    }),
  ],
})
