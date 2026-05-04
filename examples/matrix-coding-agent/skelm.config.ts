import { defineConfig } from '@skelm/core'

export default defineConfig({
  registries: {
    workflows: { glob: 'examples/matrix-coding-agent/*.workflow.ts' },
    agents: [
      {
        id: 'claude-code',
        runtime: 'claude-code',
        lifecycle: 'ephemeral',
        // Replace with your real CLI invocation:
        command: 'claude',
        args: ['--print'],
      },
    ],
    mcpServers: [
      // Stand-in for a real Matrix MCP server. The gateway tracks the URL
      // and the workflow's transport plugin would call coordinator.fire().
      { id: 'matrix', transport: 'http', url: 'http://127.0.0.1:9100' },
    ],
  },
  defaults: {
    permissions: {
      allowedExecutables: ['claude'],
      allowedTools: [],
      allowedSkills: [],
      allowedMcpServers: ['matrix'],
      fsRead: ['./'],
      fsWrite: [],
      networkEgress: 'deny',
    },
  },
})
