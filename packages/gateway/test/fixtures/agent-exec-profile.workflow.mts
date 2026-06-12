import { agent, pipeline } from '@skelm/core'

// An agent step that references the operator-defined executable profile
// 'gitReadOnly' (config.defaults.executableProfiles). The gateway must expand
// it to the profile's executables before the backend sees the policy.
export default pipeline({
  id: 'agent-exec-profile',
  steps: [
    agent({
      id: 'probe',
      backend: 'recording-profile',
      prompt: 'go',
      permissions: { networkEgress: 'allow', executableProfiles: ['gitReadOnly'] },
    }),
  ],
})
