import { defineConfig } from '@skelm/core'
import { createPiBackend } from '@skelm/pi'

// Test config for egress proxy enforcement
// Uses pi RPC backend - subprocesses get proxy env vars injected by gateway

export default defineConfig({
  server: {
    port: 14738,
    proxy: {
      enabled: true,
      port: 14739,
    },
  },
  registries: {
    workflows: { glob: 'test-egress.pipeline.ts' },
  },
  instances: [
    createPiBackend({
      id: 'pi',
      command: 'pi',
      provider: 'llamacpp',
      model: 'qwen36',
      maxConcurrent: 1,
      egressProxyUrl: 'http://127.0.0.1:14739',
    }),
  ],
  triggerSources: [],
})
