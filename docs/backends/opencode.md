# `@skelm/opencode` backend

Drives an [opencode](https://opencode.ai) coding agent over its SDK, with skelm's permission policy enforced **before** any request is forwarded.

## Install

```bash
npm i @skelm/opencode
```

## Configuration

Two layers stack:

1. **Backend-level options** (`OpencodeBackendOptions`) — agent id, model override, retries, server-level opencode defaults. Applied at backend construction.
2. **Step-level permissions** (`AgentPermissions`) — set on each `agent()` step. The opencode backend translates these into an opencode tool allowlist before each session, and validates incoming requests against the resolved policy before forwarding.

### Backend options in `skelm.config.ts`

```ts
// skelm.config.ts
import { defineConfig } from 'skelm'

export default defineConfig({
  backends: {
    agent: 'opencode',
    opencode: {
      apiKey: { secret: 'OPENCODE_API_KEY' },
      agent:  'build',                        // or 'plan' or any custom id from opencode.json
      apiUrl: 'https://api.opencode.ai',      // override for self-hosted
      timeout: 60_000,
      maxRetries: 3,
      logLevel: 'info',                       // 'debug' | 'info' | 'warn' | 'error' | 'off'
    },
  },
})
```

The full type is `OpencodeBackendOptions` — see [`packages/opencode/src/types.ts`](https://github.com/scottgl9/skelm/blob/main/packages/opencode/src/types.ts) for every accepted field, including `model`, `temperature`, `maxSteps`, and `serverPermissions` (which injects opencode-level allow/ask/deny defaults via `OPENCODE_CONFIG_CONTENT` at server start).

### Per-step permissions

`agent()` steps take skelm's `AgentPermissions`. The opencode backend maps these to opencode's internal tool surface:

| Skelm permission                       | What it allows in opencode                                  |
|----------------------------------------|-------------------------------------------------------------|
| `allowedExecutables` contains `'bash'` | The opencode `bash` tool                                    |
| `fsRead` non-empty                     | `read`, `glob`, `grep`, `list`                              |
| `fsWrite` non-empty                    | `write`, `edit` (read tools also enabled)                   |
| `allowedTools`                         | Exact-match or prefix-match against opencode tool names     |
| `allowedMcpServers`                    | Forwarded to opencode for MCP authorization                 |
| `networkEgress: 'deny'`                | Drops `webfetch` and bash-spawned network                   |

Anything not granted is denied. Skelm validates the request **before** forwarding to opencode and audits any denial.

## Usage

```ts
import { agent, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'code-review',
  input:  z.object({ pr: z.string() }),
  output: z.object({ verdict: z.string(), notes: z.array(z.string()) }),
  steps: [
    agent({
      id: 'reviewer',
      backend: 'opencode',
      prompt: (ctx) => `Review this PR and return JSON {verdict, notes}:\n${ctx.input.pr}`,
      permissions: {
        allowedTools:       [],
        allowedExecutables: [],          // no shell — read-only review
        allowedMcpServers:  [],
        allowedSkills:      [],
        fsRead:             ['./'],      // grants read/glob/grep/list inside cwd
        fsWrite:            [],          // editing denied
        networkEgress:      'deny',
      },
      output: z.object({ verdict: z.string(), notes: z.array(z.string()) }),
      maxTurns: 6,
    }),
  ],
})
```

### Multi-agent

A single workflow can dispatch to multiple opencode personas by overriding the agent id at the step level (when supported by your `OpencodeBackendOptions.agent` plumbing) or by registering separate backend instances:

```ts
import { defineConfig } from 'skelm'
import { createOpencodeBackendFromConfig } from '@skelm/opencode'

export default defineConfig({
  instances: [
    createOpencodeBackendFromConfig({ id: 'opencode-build', agent: 'build' }),
    createOpencodeBackendFromConfig({ id: 'opencode-plan',  agent: 'plan'  }),
  ],
})
```

Then reference `backend: 'opencode-build'` or `backend: 'opencode-plan'` per step.

## Capabilities

The opencode backend declares:

- `prompt: false` — `agent()` only; for single-shot inference use the OpenAI or Anthropic backend.
- `streaming: true`
- `mcp: true`
- `skills: true`
- `toolPermissions: 'native'` — opencode itself enforces the allowlist; skelm pre-validates and audits.

Capability gaps fail the step at start; nothing degrades silently.

## Errors

| Source                              | Skelm error                |
|-------------------------------------|----------------------------|
| Auth failure                        | `BackendError` (auth)      |
| Permission denial                   | `PermissionDeniedError`    |
| API/rate-limit/server               | `BackendError` (retryable) |
| Timeout                             | `BackendTimeoutError`      |

Retries: 3 attempts with exponential backoff for transient errors (connection, rate-limit, server). Configure with `maxRetries`, `timeout`.

## Troubleshooting

- **"Authentication failed"** — set `OPENCODE_API_KEY` or pass `{ secret: 'OPENCODE_API_KEY' }` in config.
- **"Permission denied: `<tool>`"** — the step's `AgentPermissions` did not grant the tool. Review the mapping table above and widen the policy if it's safe.
- **"Agent 'X' not found"** — agent id missing from your opencode workspace config (`opencode.json`). Use `'build'`, `'plan'`, or a custom id you've defined.
- **Connection timeout** — raise `timeout` in the backend config or check network reachability to `apiUrl`.

## See also

- [Backends overview](./README.md)
- [Permissions](../concepts/permissions.md)
- [Writing a backend](../guides/writing-a-backend.md)
- [opencode docs](https://opencode.ai/docs)
