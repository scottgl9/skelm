# Quickstart

Build, run, and schedule your first skelm workflow in five minutes.

## Prerequisites

- Node.js 20+
- A terminal
- (Optional, for the LLM example) An OpenAI-compatible endpoint and API key (any vendor that speaks the OpenAI Chat Completions protocol)
- (Optional, for the agent example) The pi coding-agent SDK: `npm install @mariozechner/pi-coding-agent`. Pi reads its provider/model from `~/.pi/auth.json` and `~/.pi/models.json` — see [pi's docs](https://github.com/mariozechner/pi) to point it at your model

## 1. Install

```sh
npm i -g skelm
skelm --version
```

## 2. Initialize a project

```sh
skelm init my-bot
cd my-bot
npm install
```

This scaffolds:

```
my-bot/
├── skelm.config.ts          # default-deny permissions, env-driven secrets
├── workflows/
│   └── hello.workflow.ts    # example: prints a greeting
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

## 3. Look at the example workflow

```ts
// workflows/hello.workflow.ts
import { code, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'hello',
  description: 'Greets someone by name.',
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ greeting: z.string() }),
  steps: [
    code({
      id: 'greet',
      run: (ctx) => ({ greeting: `hello, ${(ctx.input as { name: string }).name}` }),
    }),
  ],
})
```

## 4. Run it

```sh
skelm run workflows/hello.workflow.ts --input '{"name":"world"}'
```

Output:

```json
{"greeting":"hello, world"}
```

`skelm run` is sugar for "register an immediate-schedule, run it, deregister." Every workflow run goes through the scheduler; `run` is the convenient one-shot form.

Want to see the run's events?

```sh
skelm run workflows/hello.workflow.ts --input '{"name":"world"}' --events json 2> events.log
cat events.log
```

## 5. Add an agent step

Agents in skelm run on the [pi coding-agent SDK](https://www.npmjs.com/package/@mariozechner/pi-coding-agent). Install it and register it as a backend in `skelm.config.ts`:

```sh
npm install @mariozechner/pi-coding-agent @skelm/pi
```

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

Update `workflows/hello.workflow.ts`:

```ts
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

Run it:

```sh
skelm run workflows/hello.workflow.ts --input '{"name":"world"}'
```

Notice: `permissions` is **explicit and default-deny**. The agent has no tools, no executables, no filesystem access, no network outside the backend's own. If the agent tries to do anything privileged, the run fails with a permission denial — by design.

## 6. Schedule it

Run every five minutes:

```sh
skelm schedule add workflows/hello.workflow.ts \
  --cron '*/5 * * * *' \
  --input '{"name":"world"}' \
  --id hello-cron
```

Or fire on a webhook (the gateway must be running):

```sh
skelm schedule add workflows/hello.workflow.ts \
  --webhook /hello \
  --id hello-webhook
```

List your schedules:

```sh
skelm schedule list
```

Stop the cron schedule:

```sh
skelm schedule stop hello-cron
```

## 7. Run the gateway

For long-running schedules (cron, webhook, poll, queue) to fire continuously, start the gateway:

```sh
skelm gateway start
```

The gateway listens on `127.0.0.1:4000` by default and runs your schedules. Press Ctrl-C to stop with a graceful drain.

To install it as a systemd user service so it runs across reboots:

```sh
skelm gateway install --systemd
systemctl --user enable --now skelm-gateway
systemctl --user status skelm-gateway
```

## 8. Inspect runs

```sh
skelm history --last 10
skelm history --run <runId>
skelm history --run <runId> --events
```

Or via HTTP against a running gateway:

```sh
curl http://127.0.0.1:4000/runs?limit=10
curl http://127.0.0.1:4000/runs/<runId>
```

## What's next

- [Concepts → Permissions](../concepts/permissions.md) — the default-deny model, how to widen safely with profiles.
- [Concepts → Coding agents](../concepts/coding-agents.md) — how skelm's agent runtime composes with backends.
- [Concepts → Registries](../concepts/registries.md) — workflow, skill, agent, and MCP-server registries.
- [Recipes](../recipes/index.md) — complete examples of long-running and HTTP-triggered patterns.
- [CLI reference](../reference/cli.md) and [HTTP reference](../reference/http.md).

## Common gotchas

**"Permission denied: tool X"** — agent tried to use a tool not in `permissions.allowedTools`. Add the tool id explicitly. Resist the urge to use `*` — narrow allow-lists are the security tenet at work.

**"Backend X not registered"** — your `skelm.config.ts` has no entry for the backend name. Add it under `backends:` and set `backend:` on the workflow or step.

**"Gateway not reachable"** — `skelm` CLI commands that need a running gateway look for one at `SKELM_GATEWAY_URL`, then `~/.skelm/gateway.json`, then `http://127.0.0.1:4000`. Start it with `skelm gateway start`, or run the workflow locally with no gateway running and skelm will spin up an in-process one for the duration.

**"Schema validation failed"** — input did not match the workflow's `input` schema. Check `skelm describe <workflow>` for the expected shape.
