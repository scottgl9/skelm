import { defineConfig } from '@skelm/core'

// Minimal in-memory trigger source: enough for `skelm run <dir>` to classify
// this project as triggered and activate it. start/stop are no-ops so the
// activation test never starts real polling.
const memSource = {
  start() {},
  stop() {},
}

export default defineConfig({
  registries: { workflows: { glob: '*.workflow.mts' } },
  triggerSources: [{ id: 'mem', driver: memSource }],
})
