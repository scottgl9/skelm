import { defineWorkflowConfig } from '@skelm/core'

// Minimal config that turns on the agentmemory integration and grants the
// three ops the automatic backend loop uses (observe / search / session) as
// project defaults. Per-step permissions intersect with these — nothing widens.
//
// `secretName` is optional: set it (to a name your gateway's SecretResolver
// knows) only when your agentmemory server requires a bearer token.
export default defineWorkflowConfig({
  agentmemory: {
    enabled: true,
    url: 'http://localhost:3111',
    // secretName: 'AGENTMEMORY_SECRET',
    timeoutMs: 3000,
  },
  defaults: {
    permissions: {
      agentmemory: {
        allowObserve: true,
        allowSearch: true,
        allowSession: true,
        // Custom code can also use these; grant only what a step needs:
        // allowSave: true,
        // allowRecall: true,
        // allowGraph: true,
      },
    },
  },
})
