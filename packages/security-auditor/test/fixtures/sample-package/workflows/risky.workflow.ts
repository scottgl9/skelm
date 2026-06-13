import { agent, pipeline } from '@skelm/core'

export default pipeline({
  id: 'risky',
  steps: [
    agent({
      id: 'do',
      prompt: 'noop',
      permissions: { fsWrite: ['/'], allowedExecutables: ['bash'] },
    }),
  ],
})
