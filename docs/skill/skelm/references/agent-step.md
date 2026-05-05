# Agent Step Reference

## Full `agent()` signature

```ts
agent({
  id: string                                          // required
  backend?: string                                    // backend id from skelm.config.ts; default from config
  agentDef?: string                                   // named agent definition from config registries.agents
  prompt: string | ((ctx: Context) => string)         // required
  system?: string | ((ctx: Context) => string)
  mcp?: McpServerConfig[] | ((ctx: Context) => McpServerConfig[])
  workspace?: WorkspaceConfig | ((ctx: Context) => WorkspaceConfig)
  output?: ZodSchema<TOutput>                         // validates agent's final output
  permissions?: AgentPermissions                      // default-deny; all fields optional
  maxTurns?: number                                   // cap on agent tool-call turns
  retry?: RetryPolicy
})
```

## Backends

Declare backends in `skelm.config.ts` and reference them by id:

```ts
// skelm.config.ts
registries: {
  agents: [
    { id: 'claude-code', runtime: 'claude-code', lifecycle: 'ephemeral', command: 'claude', args: ['--print'] },
    { id: 'opencode',    runtime: 'opencode',    lifecycle: 'ephemeral', command: 'opencode' },
  ],
}

// in a pipeline
agent({ id: 'implement', backend: 'opencode', prompt: '...' })
```

If `backend` is omitted, the config `defaults.backend` is used (or the first declared agent).

## MCP servers

Attach MCP servers by id (must be declared in config):

```ts
// skelm.config.ts
registries: {
  mcpServers: [
    { id: 'github', transport: 'http', url: 'http://127.0.0.1:9100' },
    { id: 'filesystem', transport: 'stdio', command: 'mcp-server-filesystem', args: ['.'] },
  ],
}

// in a step
agent({
  id: 'research',
  prompt: 'Investigate the issue',
  permissions: {
    allowedMcpServers: ['github'],    // also required in permissions
  },
  mcp: [{ id: 'github' }],           // attach by id
})
```

An MCP server attached via `mcp` but absent from `allowedMcpServers` will be denied at dispatch time.

## Workspace modes

### `ephemeral` — temporary directory, auto-cleaned

```ts
workspace: {
  mode: 'ephemeral',
  prefix?: string                     // directory prefix
  cleanup?: 'on-step-end' | 'on-run-end' | 'on-success'  // default: 'on-run-end'
  seed?: { copy: string[] }           // paths copied in before step starts
}
```

### `persistent` — named, git-aware, survives restarts

```ts
workspace: {
  mode: 'persistent',
  name: string                        // workspace name; unique per pipeline id
  base?: string                       // base directory (default: ~/.skelm/workspaces)
  gitRoot?: boolean                   // initialize a git repo in the workspace
  cleanup?: 'never' | 'on-success'   // default: 'never'
  seed?: { copy: string[] }
}
```

### `mounted` — user-supplied path

```ts
workspace: {
  mode: 'mounted',
  path: string                        // absolute or cwd-relative path
  seed?: { copy: string[] }
}
```

The workspace path is available in the agent's working directory at runtime. For coding agents, this is where they read and write source files.

## Seed files

Copy project files into the workspace before the agent runs:

```ts
workspace: {
  mode: 'ephemeral',
  seed: { copy: ['./src/', './package.json', './tsconfig.json'] },
}
```

Paths are resolved relative to `process.cwd()` at step execution time.

## Full example

```ts
import { agent, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'ticket-to-pr',
  description: 'Implements a ticket and opens a PR.',
  input: z.object({ ticketId: z.string(), description: z.string() }),
  output: z.object({ prUrl: z.string() }),
  steps: [
    agent({
      id: 'implement',
      backend: 'opencode',
      prompt: (ctx) => {
        const { ticketId, description } = ctx.input as { ticketId: string; description: string }
        return `Implement ticket ${ticketId}: ${description}. Open a PR when done.`
      },
      permissions: {
        profile: 'github-write',              // from skelm.config.ts profiles
        allowedTools: ['gh.list_issues', 'gh.create_pr', 'bash'],
      },
      workspace: {
        mode: 'ephemeral',
        seed: { copy: ['./src/', './package.json', './tsconfig.json'] },
        cleanup: 'on-run-end',
      },
      maxTurns: 50,
      output: z.object({ prUrl: z.string() }),
    }),
  ],
})
```
