import { agent, pipeline } from '@skelm/core'

export default pipeline({
  id: 'bad-secret',
  steps: [
    agent({
      id: 'a1',
      prompt: 'go',
      secrets: ['bad name with spaces'],
      permissions: { networkEgress: 'deny', filesystem: { write: 'deny' } },
    }),
  ],
})
