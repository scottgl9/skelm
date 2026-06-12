import { defineWorkflowConfig } from '@skelm/core'

export default defineWorkflowConfig({
  defaults: {
    executableProfiles: {
      gitReadOnly: { description: 'git only', executables: ['git'] },
    },
  },
})
