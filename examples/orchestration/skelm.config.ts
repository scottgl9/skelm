import { defineWorkflowConfig } from '@skelm/core'

// In-workflow orchestration demo: `orchestration-triage` invokes the
// `orchestration-summary` child and fans report scans out across
// `orchestration-scan`. The registry glob is what lets ctx.workflows resolve
// the child ids at run time. No LLM backend needed — the demo is code-only.
export default defineWorkflowConfig({
  registries: {
    workflows: { glob: '*.workflow.{mts,ts}' },
  },
})
