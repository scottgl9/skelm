# `@skelm/pi` backend

Drives the [pi coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) under skelm's permission model.

Two flavours are available:

| Factory                         | How                                              | Tool enforcement                              |
|---------------------------------|--------------------------------------------------|-----------------------------------------------|
| `createPiSdkBackend` *(recommended)* | Uses the pi SDK in-process                  | **native** — pi enforces the allowlist        |
| `createPiBackendFromConfig`     | Spawns `pi --mode rpc` per call                  | **advisory** — skelm intercepts after the fact |

Use the SDK backend for new work. The RPC backend exists for environments where the SDK peer dependency cannot be installed.

The SDK backend also supports `llm()` steps — `prompt: true` in its capability declaration — which is unusual for an agent backend.

## Install

```bash
npm install @skelm/pi @mariozechner/pi-coding-agent
```

The pi SDK is a peer dependency. The RPC backend instead requires the `pi` CLI on `$PATH`:

```bash
npm install -g @mariozechner/pi-coding-agent
```

## Wiring into `skelm.config.ts`

The CLI's `backends:` shorthand wires the **RPC** backend automatically when it sees a `pi` key. To use the SDK backend, register an instance:

```ts
import { defineConfig } from 'skelm'
import { createPiSdkBackend } from '@skelm/pi'

export default defineConfig({
  backends: { agent: 'pi' },
  instances: [
    createPiSdkBackend({
      id: 'pi',
      cwd: './workspace',
      timeout: 300_000,
      maxConcurrent: 4,
    }),
  ],
})
```

For the RPC backend in `skelm.config.ts`:

```ts
backends: {
  agent: 'pi',
  pi: {
    command:  'pi',          // optional; default: 'pi' on $PATH
    provider: 'anthropic',   // pi provider; omit for pi's default
    model:    'claude-opus-4-5',
    timeout:  300_000,
    maxConcurrent: 4,
  },
}
```

The pi SDK backend does **not** accept `provider`/`model` overrides — pi resolves both from its own settings (`~/.pi/auth.json`, `~/.pi/models.json`). Configure pi externally before using the SDK backend.

## Step-level usage

```ts
import { agent, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'refactor',
  input:  z.object({ goal: z.string() }),
  output: z.object({ summary: z.string() }),
  steps: [
    agent({
      id: 'pi-step',
      backend: 'pi',
      prompt: (ctx) =>
        `${ctx.input.goal}\n\nWhen done, return JSON of the form {"summary": "..."}.`,
      permissions: {
        allowedTools:       [],
        allowedExecutables: ['bash'],
        allowedMcpServers:  [],
        allowedSkills:      [],
        fsRead:             ['./src'],
        fsWrite:            ['./src'],
        networkEgress:      'deny',
      },
      output: z.object({ summary: z.string() }),
      maxTurns: 8,
    }),
  ],
})
```

## Permission → pi tool mapping (SDK backend)

| skelm permission                                   | pi tools enabled                  |
|----------------------------------------------------|-----------------------------------|
| `allowedExecutables` contains `'bash'` / `'sh'`    | `bash`                            |
| `fsRead` non-empty                                 | `read`, `grep`, `find`, `ls`      |
| `fsWrite` non-empty                                | `write`, `edit` (read tools too)  |
| `networkEgress: 'deny'`                            | drops `bash` (no native fetch tool — disabling shell is the only way to deny network) |
| policy `undefined`                                 | pi defaults (no override)         |
| policy present, nothing granted                    | `noTools: 'all'` — all built-ins suppressed |

## ⚠ Caveats

- **`bash` is all-or-nothing.** Pi exposes a single `bash` tool, not per-binary tools. If you grant `bash`, the agent can run *any* binary. Use an MCP-host backend (opencode, claude-code) when you need per-binary filtering.
- **Filesystem paths are advisory.** `fsRead` / `fsWrite` unlock the *category* of filesystem tools; pi's `read`/`write`/`grep`/`find`/`ls` can access anywhere the pi process can. Run pi inside an isolated workspace (ephemeral cwd, OS sandbox, container) when this matters.

These caveats are inherent to pi's enforcement surface — if your threat model requires per-binary or per-path enforcement, choose the opencode backend instead.

## Capabilities

```ts
{ prompt: true, streaming: true, sessionLifecycle: true,
  mcp: false, skills: true, modelSelection: false,
  toolPermissions: 'native' }
```

The SDK backend supports skills via `formatSkillBlock` (skill metadata + body injected into the system prompt).

## See also

- [`packages/pi/README.md`](../../packages/pi/README.md) — full export list and advanced options
- [Backends overview](./README.md)
- [Permissions](../concepts/permissions.md)
