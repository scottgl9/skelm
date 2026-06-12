import { agent, pipeline } from '@skelm/core'

export default pipeline({
  id: 'exec-profiles-unknown',
  steps: [
    agent({
      id: 'reviewer',
      prompt: 'review this',
      permissions: { executableProfiles: ['doesNotExist'] },
    }),
  ],
})
