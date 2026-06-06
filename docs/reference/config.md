# Config reference (`skelm.config.ts`)

The CLI walks up from `cwd` to find `skelm.config.ts` (or `.js` / `.mjs`). When none is found, the gateway uses [`DEFAULT_CONFIG`](https://github.com/scottgl9/skelm/blob/main/packages/core/src/config.ts).

## Shape

```ts
import { defineConfig } from 'skelm'

export default defineConfig({
  entrypoint?: string,                       // workflow run by `skelm run <dir>` (relative to this file)

  // ── Backends ────────────────────────────────────────────────────────
  backend?: string,                          // legacy single-backend selector; prefer `backends.default`
  backends?: {
    default?: string,                        // used by both infer() and agent() unless overridden
    infer?:     string,                        // optional override for infer()
    agent?:   string,                        // optional override for agent()
    [id: string]: SkelmConfigBackendEntry | string | undefined,
  },
  /**
   * Pre-built `SkelmBackend` instances. Use this when the string-keyed
   * `backends:` form is insufficient — e.g. the pi SDK backend, custom
   * ACP backends, or a backend you wrote yourself.
   */
  instances?: readonly SkelmBackend[],

  // ── Workflow discovery ──────────────────────────────────────────────
  pipelines?: {
    discovery?: 'auto' | 'explicit',
    glob?:      string,                      // e.g. 'workflows/**/*.workflow.{mts,ts}'
    explicit?:  readonly string[],
  },

  // ── Gateway-managed registries ──────────────────────────────────────
  registries?: {
    workflows?:  { glob?: string },          // file-system discovery for *.workflow.{mts,ts} / *.pipeline.{mts,ts}
    skills?:     { glob?: string },          // skill SKILL.md directories
    mcpServers?: readonly SkelmConfigMcpServerEntry[],
    agents?:     readonly SkelmConfigAgentEntry[],   // gateway-supervised agent runtimes
  },

  // ── Defaults & profiles ─────────────────────────────────────────────
  defaults?: {
    backend?:            string,             // alias for backends.default
    permissions?:        AgentPermissions,   // project-wide permission baseline
    permissionProfiles?: Record<string, AgentPermissions>,
  },

  // ── Operational surfaces ────────────────────────────────────────────
  secrets?: {
    driver?: 'env' | 'file',
    file?:   string,                         // path to JSON secrets file when driver === 'file'
  },
  storage?: {
    runs?:       { driver?: 'sqlite' | 'memory', path?: string },
    state?:      { driver?: 'sqlite' | 'memory', path?: string },
    workspaces?: { base?: string, ephemeralBase?: string },
  },
  server?: {
    port?:              number,              // default: 14738
    host?:              string,              // default: 127.0.0.1
    auth?:              { mode: 'none' | 'bearer' },
    maxConcurrentRuns?: number,              // default: 10
    proxy?: {
      enabled?: boolean,                     // default: true
      port?: number,                         // default: server.port + 1
    },
  },
  plugins?: readonly string[],               // package names imported at gateway startup

  // ── Environment variables ───────────────────────────────────────────
  env?: Record<string, string>,              // static defaults; layered with .env (see below)
})
```

`SkelmConfigBackendEntry` is a free-form record forwarded to the matching factory. Strings allowed for keys like `backends.default` (selectors), record values for backend-specific config (`apiKey`, `model`, `baseUrl`, …).

## Backends

The CLI knows these ids and wires them automatically:

| id              | factory                                | notes                                  |
|-----------------|----------------------------------------|----------------------------------------|
| `openai`        | `createOpenAIBackend`                  | OpenAI-compatible HTTP endpoint        |
| `anthropic`     | `createAnthropicBackend`               | Direct Anthropic API                   |
| `skelm-agent`   | `createSkelmAgentBackend`              | OpenAI-compatible agent loop           |
| `opencode`      | `createOpencodeBackendFromConfig`      | opencode SDK                           |
| `copilot-acp`   | `createAcpBackend`                     | GitHub Copilot ACP subprocess          |
| `acp`           | `createAcpBackend`                     | Generic ACP; `command` required        |
| `pi`            | `createPiSdkBackend`                   | Pi SDK backend                         |

For Pi, either configure the `pi` backend entry or register an instance:

```ts
import { defineConfig } from 'skelm'
import { createPiSdkBackend } from '@skelm/pi'

export default defineConfig({
  backends: {
    agent: 'pi',
    pi: {
      provider: 'openai',
      model: 'qwen36',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'unused',
    },
  },
  // or: instances: [createPiSdkBackend({ id: 'pi', ... })],
})
```

API keys can be inlined (`apiKey: 'sk-...'`) or resolved from env (`apiKey: { secret: 'OPENAI_API_KEY' }`). The runtime resolves the secret at gateway start.

For `skelm-agent`, `headers` may also contain string values or env-backed
secret references. This is useful for OpenRouter attribution headers:

```ts
'skelm-agent': {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: { secret: 'OPENROUTER_API_KEY' },
  model: 'openai/gpt-5.2',
  headers: {
    'HTTP-Referer': 'https://skelm.dev',
    'X-OpenRouter-Title': 'skelm',
  },
}
```

## Agent registry entries

`registries.agents` declares agent runtimes the **gateway** supervises (process lifecycle, command, env). This is separate from the `backends:` map (which registers `SkelmBackend` instances directly).

```ts
interface SkelmConfigAgentEntry {
  id: string
  runtime: 'claude-code' | 'opencode' | 'pi' | 'acp' | string
  lifecycle: 'ephemeral' | 'resident'
  command?: string                    // spawn command for ephemeral, or `serve` for resident
  args?: readonly string[]
  url?: string                        // when the agent is reachable as a long-lived server
  env?: Readonly<Record<string, string>>
  permissions?: AgentPermissions      // applied to every step that uses this agent
  metadata?: Readonly<Record<string, unknown>>
}
```

- `ephemeral` — spawned per step, exits when done.
- `resident` — gateway keeps the process alive, reuses across steps.

## MCP server entries

```ts
interface SkelmConfigMcpServerEntry {
  id: string
  transport: 'stdio' | 'http' | 'sse'
  // stdio:
  command?: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  // http / sse:
  url?: string
}
```

## Full example

```ts
import { defineConfig } from 'skelm'
import { createPiSdkBackend } from '@skelm/pi'

export default defineConfig({
  backends: {
    default: 'openai',
    agent:   'pi',
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey:  { secret: 'OPENAI_API_KEY' },
      model:   'gpt-4o-mini',
    },
  },
  instances: [createPiSdkBackend({ id: 'pi' })],

  pipelines: { discovery: 'auto', glob: 'workflows/**/*.workflow.{mts,ts}' },

  registries: {
    workflows:  { glob: 'workflows/**/*.workflow.{mts,ts}' },
    skills:     { glob: 'skills/**/SKILL.md' },
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
        allowedTools:       ['gh.*'],
        allowedMcpServers:  ['github'],
        fsRead:             ['./'],
        fsWrite:            ['./'],
        networkEgress:      { allowHosts: ['api.github.com'] },
      },
    },
  },

  secrets: { driver: 'env' },

  storage: {
    runs:  { driver: 'sqlite', path: '.skelm/runs.sqlite' },
    state: { driver: 'sqlite', path: '.skelm/state.sqlite' },
  },

  server: {
    port: 14738,
    host: '127.0.0.1',
    auth: { mode: 'none' },
  },
})
```

## Environment variables — `.env` and `config.env`

The CLI loads environment variables from two layered sources at startup so workflow authors can keep model names, base URLs, and similar defaults out of code:

1. **`config.env`** — static defaults declared inside `skelm.config.mts`.
2. **`<projectRoot>/.env`** — a [dotenv](https://github.com/motdotla/dotenv) file at the same directory as the config file. Add it to `.gitignore` if it carries secrets.
3. **`process.env`** — the parent process's environment, always wins.

Precedence is `process.env > .env > config.env`. The CLI merges the lower layers into `process.env` so subprocess steps (`ctx.exec`, coding agents, MCP servers) inherit them, but **values already set in the parent process are never overwritten** — running `OPENAI_BASE_URL=https://staging skelm run …` keeps the explicit override.

```ts
// skelm.config.mts
import { defineConfig } from 'skelm'

export default defineConfig({
  env: {
    OPENAI_MODEL: 'gpt-4o-mini',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
  },
})
```

```bash
# .env (gitignored)
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o   # overrides config.env default
```

```bash
# explicit override wins over both
OPENAI_MODEL=gpt-4-turbo skelm run my.workflow.mts
```

For secrets accessed via `step.secrets` declarations, the existing `secrets.driver` mechanism is the right channel — the `.env` layer is intended for non-secret defaults and for operators who already manage secrets via `.env` files.

For the full list of variables skelm reads at runtime, see the [Environment variables reference](./environment-variables.md).

## entrypoint

When `skelm run <directory>` targets a directory, the CLI looks for a
`skelm.config.*` in that directory and runs the workflow named by its
`entrypoint` field, resolved relative to the config file. This lets a workflow
project be run by directory:

```ts
// myproject/skelm.config.mts
export default defineConfig({ entrypoint: './myproject.workflow.mts' })
```

```bash
skelm run myproject        # runs myproject/myproject.workflow.mts
```

When unset, `skelm run <dir>` falls back to `index.workflow.{mts,ts}` or a
single unambiguous `*.workflow.{mts,ts}` file. See the
[`skelm run` reference](./cli.md). Note the gateway resolves backends from the
config it was **started** with, so a project's own backend wiring only applies
when the gateway runs with that config.

## Notes

- Config is hot-reloaded when the gateway receives `SIGHUP` or `skelm gateway reload`.
- `permissionProfiles` entries narrow `defaults.permissions`; profiles cannot widen the project baseline.
- When `registries.workflows.glob` is omitted, the gateway uses the value from `pipelines.glob` (or the default `workflows/**/*.workflow.{mts,ts}`).
- `secrets.driver: 'file'` reads JSON from `secrets.file`; the gateway never logs secret values.
