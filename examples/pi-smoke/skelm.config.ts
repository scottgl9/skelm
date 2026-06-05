import { defineConfig } from '@skelm/core'
import { createPiSdkBackend } from '@skelm/pi'

// Standalone config for the pi smoke example. Registers the @skelm/pi backend
// as `pi`. The backend reads provider/model settings from explicit options,
// OPENAI_* env vars, or pi's own project-local config.
export default defineConfig({
  registries: {
    workflows: { glob: '*.pipeline.{mts,ts}' },
  },
  instances: [
    createPiSdkBackend({
      id: 'pi',
      noExtensions: true,
      noSkills: true,
    }),
  ],
})
