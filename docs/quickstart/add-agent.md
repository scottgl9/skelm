# Add an agent step

Picks up where the [Quickstart](./README.md) leaves off. You should already have `my-bot` running the code-only `hello` workflow.

## 1. Install a backend

Agents in skelm run on the [pi coding-agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Install it and the `@skelm/pi` adapter:

```sh
npm install @earendil-works/pi-coding-agent @skelm/pi
```

Pi reads its provider/model from `~/.pi/auth.json` and `~/.pi/models.json` — see [pi's docs](https://github.com/mariozechner/pi) to point it at your model.

## 2. Register the backend

```ts
// skelm.config.ts
import { defineConfig } from 'skelm'
import { createPiSdkBackend } from '@skelm/pi'

export default defineConfig({
  backends: { agent: 'pi' },
  instances: [createPiSdkBackend({ id: 'pi' })],
  pipelines: { discovery: 'auto', glob: 'workflows/**/*.workflow.ts' },
  secrets: { driver: 'env' },
})
```

## 3. Convert `hello` to use an agent step

```ts
// workflows/hello.workflow.ts
import { agent, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'hello',
  description: 'Greet someone with an agent-generated message.',
  input:  z.object({ name: z.string() }),
  output: z.object({ greeting: z.string() }),
  steps: [
    agent({
      id: 'greet',
      backend: 'pi',
      prompt: (ctx) =>
        `Greet ${ctx.input.name} in one short sentence. Return JSON of the form {"greeting": "..."} and nothing else.`,
      permissions: {
        allowedTools:       [],          // no tools needed
        allowedExecutables: [],
        allowedMcpServers:  [],
        allowedSkills:      [],
        networkEgress:      'deny',      // backend handles its own outbound
        fsRead:             [],
        fsWrite:            [],
      },
      output: z.object({ greeting: z.string() }),
      maxTurns: 2,
    }),
  ],
})
```

## 4. Run it

```sh
skelm run workflows/hello.workflow.ts --input '{"name":"world"}'
```

`permissions` is **explicit and default-deny**. The agent has no tools, no executables, no filesystem access, no network outside the backend's own. If the agent tries to do anything privileged, the run fails with a permission denial — by design.

## Next

- [Concepts → Permissions](../concepts/permissions.md) — how to widen the allow-list safely with profiles.
- [Backends](../backends/) — every supported backend (Pi, Opencode, ACP runtimes, Anthropic, OpenAI, Vercel AI).
- [Recipes](../recipes/) — complete examples like ticket-to-PR and chat-driven coding agents.
