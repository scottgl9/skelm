import { defineConfig } from 'skelm'

export default defineConfig({
  registries: {
    workflows: { glob: './*.pipeline.ts' },

    // Declare coding agent backends here. Each step references one by id.
    agents: [
      // { id: 'opencode',    runtime: 'opencode',    lifecycle: 'ephemeral', command: 'opencode' },
      // { id: 'claude-code', runtime: 'claude-code', lifecycle: 'ephemeral', command: 'claude', args: ['--print'] },
    ],

    // Declare MCP servers here. Steps reference them by id in agent({ mcp: [{ id }] }).
    mcpServers: [
      // { id: 'github',     transport: 'http',  url: 'http://127.0.0.1:9100' },
      // { id: 'filesystem', transport: 'stdio', command: 'mcp-server-filesystem', args: ['.'] },
    ],
  },

  defaults: {
    // Project-wide permission baseline. All agent steps start here and can only narrow.
    permissions: {
      allowedExecutables: [],
      allowedTools: [],
      allowedSkills: [],
      allowedMcpServers: [],
      fsRead: ['./'],
      fsWrite: [],
      networkEgress: 'deny',
    },

    // Named profiles that steps can reference via permissions: { profile: '...' }
    permissionProfiles: {
      // 'read-only': {
      //   fsRead: ['./'],
      //   networkEgress: 'deny',
      // },
      // 'github-write': {
      //   allowedExecutables: ['git'],
      //   allowedTools: ['gh.*'],
      //   allowedMcpServers: ['github'],
      //   fsRead: ['./'],
      //   fsWrite: ['./'],
      //   networkEgress: { allowHosts: ['api.github.com'] },
      // },
    },
  },

  server: {
    port: 2318,
    auth: { mode: 'none' }, // set to 'bearer' with a token for remote access
  },

  storage: {
    runs: { driver: 'sqlite', path: '.skelm/runs.db' },
    audit: { driver: 'sqlite', path: '.skelm/audit.db' },
  },
})
