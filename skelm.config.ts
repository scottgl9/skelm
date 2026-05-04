import { defineConfig } from './packages/core/src/index.js'

export default defineConfig({
  backend: 'opencode',
  backends: {
    default: 'opencode',
    opencode: {
      apiUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key',
      model: 'qwen36',
    },
    pi: {
      command: 'pi',
    },
  },
  defaults: {
    permissions: {
      networkEgress: 'deny',
      allowedExecutables: [],
      allowedTools: [],
      allowedSkills: [],
      allowedMcpServers: [],
      fsRead: [],
      fsWrite: [],
    },
  },
  registries: {
    workflows: { glob: '**/*.workflow.ts' },
    agents: [],
    mcpServers: [],
  },
})
