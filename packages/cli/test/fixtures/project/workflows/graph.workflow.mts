import { agent, branch, code, forEach, loop, parallel, pipeline } from '@skelm/core'

export default pipeline({
  id: 'graph-workflow',
  description: 'Graph-shaped workflow for describe tests',
  steps: [
    parallel({
      id: 'fanout',
      steps: [
        code({
          id: 'left',
          run: () => 'left',
        }),
        code({
          id: 'right',
          run: () => 'right',
        }),
      ],
    }),
    branch({
      id: 'route',
      on: () => 'default',
      cases: {
        happy: code({
          id: 'happy-path',
          run: () => 'happy',
        }),
      },
      default: code({
        id: 'fallback',
        run: () => 'fallback',
      }),
    }),
    loop({
      id: 'repeat',
      while: () => false,
      maxIterations: 2,
      step: code({
        id: 'repeat-body',
        run: () => 'loop',
      }),
    }),
    forEach({
      id: 'collect',
      items: () => [1, 2],
      step: (item) =>
        code({
          id: `collect-${item}`,
          run: () => item,
        }),
    }),
    agent({
      id: 'review',
      prompt: 'describe this graph',
      permissions: {
        allowedTools: ['demo.echo'],
        allowedExecutables: ['rg'],
      },
    }),
  ],
})
