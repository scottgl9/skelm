import { defineWorkflowConfig } from '@skelm/core'

// Project-level permission ceiling: grants the three agentmemory ops the
// automatic backend loop uses (observe / search / session). Per-step
// permissions intersect with these — nothing widens.
//
// The agentmemory integration itself (URL, secret, timeout) is configured in
// skelm.gateway.ts — that is operator-owned and runtime-local.
export default defineWorkflowConfig({
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
