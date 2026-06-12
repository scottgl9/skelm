import { agent, pipeline } from '@skelm/core'

// References an executable profile no config defines. Every gateway run path
// must reject this at workflow load, before a run starts or a backend runs.
export default pipeline({
  id: 'agent-exec-profile-unknown',
  steps: [
    agent({
      id: 'probe',
      backend: 'recording-profile',
      prompt: 'go',
      permissions: { networkEgress: 'allow', executableProfiles: ['doesNotExist'] },
    }),
  ],
})
