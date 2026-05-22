import { defineConfig } from '@skelm/core'
import { createPiSdkBackend } from '@skelm/pi'

// Standalone config for the pi-sdk-smoke example. Registers the
// @skelm/pi SDK backend (in-process; requires `@earendil-works/pi-coding-agent`
// to be available) as `pi-sdk`. The SDK reads its provider/model from pi's
// own project-local config — see https://github.com/mariozechner/pi-ai for
// how to configure it.
export default defineConfig({
  registries: {
    workflows: { glob: '*.pipeline.{mts,ts}' },
  },
  instances: [
    createPiSdkBackend({
      id: 'pi-sdk',
      noExtensions: true,
      noSkills: true,
    }),
  ],
})
