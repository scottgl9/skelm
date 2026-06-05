# `@skelm/pi` backend

Drives the [pi coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) through its SDK under skelm's permission model.

The Pi backend supports both `agent()` and `infer()` steps. It passes a native tool allowlist to pi so pi enforces the enabled built-in tools for the session.

## Install

```bash
npm install @skelm/pi @earendil-works/pi-coding-agent
```

## Wiring into `skelm.config.ts`

The CLI wires the `pi` backend id to the SDK backend automatically:

```ts
import { defineConfig } from 'skelm'

export default defineConfig({
  backends: {
    agent: 'pi',
    pi: {
      provider: 'openai',
      model: 'qwen36',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'unused',
      maxConcurrent: 4,
    },
  },
})
```

You can also register an explicit instance:

```ts
import { defineConfig } from 'skelm'
import { createPiSdkBackend } from '@skelm/pi'

export default defineConfig({
  backends: { agent: 'pi' },
  instances: [
    createPiSdkBackend({
      id: 'pi',
      provider: 'openai',
      model: 'qwen36',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'unused',
      cwd: './workspace',
      timeout: 300_000,
      maxConcurrent: 4,
    }),
  ],
})
```

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
        networkEgress:      'allow',
      },
      output: z.object({ summary: z.string() }),
      maxTurns: 8,
    }),
  ],
})
```

## Permission to pi tool mapping

| skelm permission                                   | pi tools enabled                  |
|----------------------------------------------------|-----------------------------------|
| `allowedExecutables` contains `'bash'` / `'sh'`    | `bash`                            |
| `fsRead` non-empty                                 | `read`, `grep`, `find`, `ls`      |
| `fsWrite` non-empty                                | `write`, `edit` (read tools too)  |
| `networkEgress: 'deny'`                            | refused before dispatch           |
| policy `undefined`                                 | pi defaults (no override)         |
| policy present, nothing granted                    | `noTools: 'all'` — all built-ins suppressed |

## Caveats

- **`bash` is all-or-nothing.** Pi exposes a single `bash` tool, not per-binary tools. If you grant `bash`, the agent can run any binary. Use an MCP-host backend such as opencode when you need per-binary filtering.
- **Filesystem paths are advisory.** `fsRead` / `fsWrite` unlock the category of filesystem tools; pi's `read`/`write`/`grep`/`find`/`ls` can access anywhere the pi process can. Run pi inside an isolated workspace, OS sandbox, or container when this matters.
- **In-process egress cannot be proxied.** Pi SDK calls run in-process, so skelm refuses `networkEgress: 'deny'` or host allowlists for Pi steps. Set `networkEgress: 'allow'` when the Pi provider may call an upstream model.

## Capabilities

```ts
{ prompt: true, streaming: true, sessionLifecycle: true,
  mcp: false, skills: true, modelSelection: false,
  toolPermissions: 'native' }
```

The backend supports skills via `formatSkillBlock` (skill metadata + body injected into the system prompt).

## See also

- [`packages/pi/README.md`](https://github.com/scottgl9/skelm/blob/main/packages/pi/README.md) — full export list and advanced options
- [Backends overview](./README.md)
- [Permissions](../concepts/permissions.md)
