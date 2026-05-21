import { defineConfig } from '@skelm/core'

// No LLM backend needed — this pipeline uses only code() and wait() steps.
export default defineConfig({
  registries: { workflows: { glob: '*.pipeline.ts' } },
})
