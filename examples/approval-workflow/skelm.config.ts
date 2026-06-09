import { defineWorkflowConfig } from '@skelm/core'

// No LLM backend needed — this pipeline uses only code() and wait() steps.
export default defineWorkflowConfig({
  registries: { workflows: { glob: '*.pipeline.{mts,ts}' } },
})
