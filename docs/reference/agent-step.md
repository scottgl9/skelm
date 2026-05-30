# Agent step reference

## Full `agent()` signature

```ts
agent({
  id: string                                          // required
  backend?: string | readonly string[]                // backend id(s) — first match wins
  agentDef?: string                                   // dir with AGENTS.md (+ optional SOUL.md), resolved vs. the workflow file
  prompt: string | ((ctx: Context) => string)         // required
  system?: string | ((ctx: Context) => string)
  systemPromptMode?: 'extend' | 'replace'             // 'extend' (default) keeps the built-in sections
  systemPromptIncludeAgentDef?: boolean               // with 'replace', still inject AGENTS.md/SOUL.md (default true)
  mcp?: McpServerConfig[] | ((ctx: Context) => McpServerConfig[])
  skills?: readonly string[]                          // skill ids the agent should load
  secrets?: readonly string[]                         // secret names resolved before the run
  workspace?: WorkspaceConfig | ((ctx: Context) => WorkspaceConfig)
  output?: SkelmSchema<TOutput>                       // validates agent's final output
  permissions?: AgentPermissions                      // default-deny; all fields optional
  maxTurns?: number                                   // cap on agent tool-call turns
  timeoutMs?: number                                  // wall-clock cap; positive integer
  state?: StateConfig
  retry?: RetryPolicy
})
```

## Backends

Two ways to register a backend:

1. **`backends:` map** — string-keyed; the CLI wires the standard factories from your config.
   ```ts
   // skelm.config.ts
   import { defineConfig } from 'skelm'

   export default defineConfig({
     backends: {
       default: 'openai',
       opencode: { apiKey: { secret: 'OPENCODE_API_KEY' }, agent: 'build' },
     },
   })
   ```
2. **`instances:` array** — pre-built `SkelmBackend` values. Use this for the pi SDK backend or any custom backend.
   ```ts
   import { defineConfig } from 'skelm'
   import { createPiSdkBackend } from '@skelm/pi'

   export default defineConfig({
     backends: { agent: 'pi' },
     instances: [createPiSdkBackend({ id: 'pi' })],
   })
   ```

Reference by id at the step level:

```ts
agent({ id: 'implement', backend: 'pi', prompt: '...' })
```

If `backend` is omitted on the step, the runtime resolves it from (in order): `config.backends.agent`, `config.backends.default`, `config.backend`, `config.defaults.backend`. If none of those is set the step fails at start.

### Pi backends (`@skelm/pi`)

Two pi backends ship in `@skelm/pi`. Prefer the **SDK** backend — it gives you native enforcement of the skelm permission policy and supports both `agent()` and `infer()` steps.

| | `createPiBackend` (RPC) | `createPiSdkBackend` (SDK) |
|---|---|---|
| Tool enforcement | Advisory | **Native** — pi hard-enforces the allowlist |
| `infer()` support  | No                      | Yes                          |
| System prompt    | Not controllable        | Pi's default; `req.system` appended; optional full replace |
| Peer dep         | `pi` CLI on `$PATH`     | `@earendil-works/pi-coding-agent` npm package |

Wiring:

```ts
import { defineConfig } from 'skelm'
import { createPiSdkBackend } from '@skelm/pi'

export default defineConfig({
  backends: { agent: 'pi' },
  instances: [
    createPiSdkBackend({ id: 'pi', maxConcurrent: 4 }),
  ],
})
```

The SDK backend defaults to `noExtensions: true` and `noSkills: true` so project-local pi extensions and skills don't expand the tool surface or duplicate skelm's skill injection. `noContextFiles: false` (default) keeps `AGENTS.md` and `.pi/context/` loaded.

Permission → pi tool mapping:
- `allowedExecutables` has `bash`/`sh` → `bash`
- `fsRead` non-empty → `read`, `grep`, `find`, `ls`
- `fsWrite` non-empty → `write`, `edit` (+ read tools)
- `networkEgress: 'deny'` → drops `bash` (pi has no native fetch tool, so removing shell is the only way to deny network)

⚠ **Permission semantics with the SDK backend differ from MCP-host backends.** Pi has one `bash` tool (not per-binary) — granting `bash` lets the agent run any executable. Filesystem paths are advisory: `fsRead`/`fsWrite` unlock the tool *category* but don't constrain paths. Use the SDK backend inside an already-bounded workspace (ephemeral cwd, OS sandbox, container); use MCP-host backends (opencode) when you need per-call binary/path enforcement.

## Agent definition (`agentDef`)

`agentDef` points at a directory holding an `AGENTS.md` (required, the agent's
instructions) and an optional `SOUL.md` (its persona/voice). The path resolves
relative to the **workflow file's directory**, and the loaded content extends the
system prompt — `SOUL.md` then `AGENTS.md`, after the built-in default sections and
before any inline `system`. See [system prompt construction](../concepts/system-prompt.md)
for the full ordering.

```ts
agent({
  id: 'support',
  agentDef: './agents/support',   // ./agents/support/AGENTS.md (+ optional SOUL.md)
  prompt: (ctx) => (ctx.input as { question: string }).question,
})
```

Use `agentDef` (files) for a durable persona, and inline `system` for a per-run
extension on top of it. `systemPromptMode: 'replace'` drops the built-in default
sections; pair it with `systemPromptIncludeAgentDef: false` to drop AGENTS.md/SOUL.md
too. A relative `agentDef` on a pipeline with no source file (constructed in-process)
fails the step explicitly — use an absolute path there.

## MCP servers

Attach MCP servers declared in `skelm.config.ts`:

```ts
// skelm.config.ts
registries: {
  mcpServers: [
    { id: 'github',     transport: 'http',  url: 'http://127.0.0.1:9100' },
    { id: 'filesystem', transport: 'stdio', command: 'mcp-server-filesystem', args: ['.'] },
  ],
}
```

In a step, the server must be both attached (`mcp:`) **and** allowed (`permissions.allowedMcpServers:`):

```ts
agent({
  id: 'research',
  backend: 'pi',
  prompt: 'Investigate the issue.',
  permissions: { allowedMcpServers: ['github'] },
  mcp: [{ id: 'github' }],
})
```

A server attached via `mcp:` but absent from `allowedMcpServers` is denied at dispatch.

## Workspace modes

### `ephemeral` — temporary directory, auto-cleaned

```ts
workspace: {
  mode: 'ephemeral',
  prefix?: string,                                       // directory prefix
  cleanup?: 'on-step-end' | 'on-run-end' | 'on-success', // default: 'on-run-end'
  seed?: { copy: readonly string[] },                    // paths copied in before step starts
}
```

### `persistent` — named, git-aware, survives restarts

```ts
workspace: {
  mode: 'persistent',
  name: string,                        // workspace name; unique per pipeline id
  base?: string,                       // base directory
  gitRoot?: boolean,                   // initialize a git repo in the workspace
  cleanup?: 'never' | 'on-success',    // default: 'never'
  seed?: { copy: readonly string[] },
}
```

### `mounted` — user-supplied path

```ts
workspace: {
  mode: 'mounted',
  path: string,                        // absolute or cwd-relative path
  seed?: { copy: readonly string[] },
}
```

The workspace path becomes the agent's cwd; coding agents read/write source files there.

### `git-repo` — clone-or-fetch a remote repo at a specific ref

```ts
workspace: {
  mode: 'git-repo',
  repo: 'owner/name' | 'https://…',     // `owner/name` resolves to https://github.com/owner/name.git
  ref: string,                          // branch, tag, or commit SHA
  baseRef?: string,                     // optional second ref to fetch (e.g. PR base)
  cacheDir?: string,                    // defaults to ~/.skelm/repos/<owner>__<name>
  auth?: { env: string },               // env var holding a bearer token (e.g. 'GITHUB_TOKEN')
  seed?: { copy: readonly string[] },
}
```

First use clones with `--filter=blob:none`; subsequent runs reuse the same
cache directory and `git fetch` the requested ref instead of cloning again.
The repo is left in a detached-HEAD checkout at `FETCH_HEAD`. When `auth` is
set the token is injected per-invocation via `http.extraheader` so it is not
persisted in `git remote -v`.

This mode replaces hand-rolled clone-or-fetch logic in PR-review pipelines —
authors no longer maintain a `code()` step that calls `git clone`/`git fetch`/
`git checkout` against a manually-managed cache dir.

## Seed files

```ts
workspace: {
  mode: 'ephemeral',
  seed: { copy: ['./src/', './package.json', './tsconfig.json'] },
}
```

Paths are resolved relative to `process.cwd()` when the step executes.

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
      backend: 'pi',
      prompt: (ctx) => {
        const { ticketId, description } = ctx.input as { ticketId: string; description: string }
        return `Implement ticket ${ticketId}: ${description}. Open a PR when done. Return JSON {prUrl}.`
      },
      permissions: {
        profile: 'github-write',                              // from skelm.config.ts profiles
        allowedTools:       ['gh.list_issues', 'gh.create_pr'],
        allowedExecutables: ['git', 'bash'],
        allowedMcpServers:  ['github'],
        allowedSkills:      [],
        fsRead:             ['./'],
        fsWrite:            ['./src/'],
        networkEgress:      { allowHosts: ['api.github.com'] },
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
