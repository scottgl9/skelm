# Config Reference (`skelm.config.ts`)

## Shape

```ts
import { defineConfig } from 'skelm'

export default defineConfig({
  registries?: {
    workflows?: { glob: string }           // glob for *.pipeline.ts / *.workflow.ts
    agents?: SkelmConfigAgentEntry[]       // coding agent definitions
    mcpServers?: SkelmConfigMcpServerEntry[]
    skills?: { glob: string }              // skill SKILL.md directories
  },
  defaults?: {
    backend?: string                       // default backend id for llm/agent steps
    model?: string
    permissions?: AgentPermissions         // project-wide permission defaults
    permissionProfiles?: Record<string, AgentPermissions>  // named profiles
  },
  server?: {
    port?: number                          // gateway HTTP port (default: 2318)
    host?: string
    auth?: { mode: 'none' | 'bearer'; token?: string }
  },
  storage?: {
    runs?: { driver: 'sqlite' | 'memory'; path?: string }
    audit?: { driver: 'sqlite' | 'memory'; path?: string }
  },
  secrets?: {
    driver: 'env' | 'vault'
    prefix?: string
  },
})
```

## Agent entries

```ts
interface SkelmConfigAgentEntry {
  id: string
  runtime: 'claude-code' | 'opencode' | 'pi' | 'acp' | string
  lifecycle: 'ephemeral' | 'resident'
  command: string                    // executable to spawn
  args?: string[]
  env?: Record<string, string>
}
```

- `ephemeral` — spawned per agent step, exits when done.
- `resident` — gateway keeps the process alive, reuses across steps.

## MCP server entries

```ts
interface SkelmConfigMcpServerEntry {
  id: string
  transport: 'stdio' | 'http' | 'sse'
  // for stdio:
  command?: string
  args?: string[]
  env?: Record<string, string>
  // for http/sse:
  url?: string
}
```

## Full example

```ts
import { defineConfig } from 'skelm'

export default defineConfig({
  registries: {
    workflows: { glob: './*.pipeline.ts' },
    agents: [
      {
        id: 'claude-code',
        runtime: 'claude-code',
        lifecycle: 'ephemeral',
        command: 'claude',
        args: ['--print'],
      },
    ],
    mcpServers: [
      { id: 'github',     transport: 'http',  url: 'http://127.0.0.1:9100' },
      { id: 'filesystem', transport: 'stdio', command: 'mcp-server-filesystem', args: ['.'] },
    ],
  },
  defaults: {
    permissions: {
      allowedExecutables: [],
      allowedTools: [],
      allowedSkills: [],
      allowedMcpServers: [],
      fsRead: ['./'],
      fsWrite: [],
      networkEgress: 'deny',
    },
    permissionProfiles: {
      'github-write': {
        allowedExecutables: ['git'],
        allowedTools: ['gh.*'],
        allowedMcpServers: ['github'],
        fsRead: ['./'],
        fsWrite: ['./'],
        networkEgress: { allowHosts: ['api.github.com'] },
      },
    },
  },
  server: {
    port: 2318,
    auth: { mode: 'none' },
  },
  storage: {
    runs:  { driver: 'sqlite', path: '.skelm/runs.db' },
    audit: { driver: 'sqlite', path: '.skelm/audit.db' },
  },
})
```

## Notes

- The config file is hot-reloaded when the gateway receives `SIGHUP` or when `skelm gateway reload` is called.
- `permissionProfiles` entries are resolved before step-level permissions; they cannot widen above project `defaults.permissions`.
- If `registries.workflows` is omitted, the gateway uses `**/*.pipeline.ts` and `**/*.workflow.ts` from the project root.
