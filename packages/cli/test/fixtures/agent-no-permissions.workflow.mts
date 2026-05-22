import { agent, pipeline } from '@skelm/core'

export default pipeline({
  id: 'agent-no-perms',
  steps: [
    agent({
      id: 'reviewer',
      prompt: 'review this',
      // permissions intentionally omitted — validate should flag this.
    }),
  ],
})
