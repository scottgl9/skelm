# Quickstart

Build, run, and schedule your first skelm workflow in five minutes.

## Prerequisites

- Node.js 20+
- A terminal
- (Optional, for the agent example) An Anthropic API key in `ANTHROPIC_API_KEY`

## 1. Install

```sh
npm i -g skelm
skelm --version
```

## 2. Initialize a project

```sh
skelm init my-bot
cd my-bot
```

This scaffolds:

```
my-bot/
├── skelm.config.ts          # default-deny permissions, env-driven secrets
├── workflows/
│   └── hello.workflow.ts    # example: prints a greeting
├── agents/                  # empty; populated when you add an agent step
├── skills/                  # empty
├── package.json
└── tsconfig.json
```

## 3. Look at the example workflow

```ts
// workflows/hello.workflow.ts
import { pipeline, code } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'hello',
  description: 'Greet someone.',
  input:  z.object({ name: z.string() }),
  output: z.object({ greeting: z.string() }),
  steps: [
    code({
      id: 'greet',
      run: (ctx) => ({ greeting: `Hello, ${ctx.input.name}!` }),
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
{ "greeting": "Hello, world!" }
```

`skelm run` is sugar for "register an immediate-schedule, run it, deregister." Every workflow run goes through the scheduler; `run` is the convenient one-shot form.

Want to see the run's events?

```sh
skelm run workflows/hello.workflow.ts --input '{"name":"world"}' --events json 2> events.log
cat events.log
```

## 5. Add an agent step

Create `agents/greeter/AGENTS.md`:

```markdown
---
name: greeter
description: Generates a friendly, personalized greeting.
version: 1
---

# Greeter

You are a warm but concise greeter. When given a name, produce one sentence of greeting tailored to that name. Avoid emojis.
```

Update `workflows/hello.workflow.ts`:

```ts
import { pipeline, agent } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'hello',
  description: 'Greet someone with an LLM-generated message.',
  input:  z.object({ name: z.string() }),
  output: z.object({ greeting: z.string() }),
  steps: [
    agent({
      id: 'greet',
      backend: 'anthropic',
      agentDef: './agents/greeter',
      prompt: (ctx) => `Greet ${ctx.input.name}.`,
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

## 6. Schedule it <!-- @planned M3 -->

> **Note:** `skelm schedule` is not yet implemented. The commands below document the intended interface; they will be available in M3. Until then, triggers are defined in `skelm.config.ts` (see [Triggers guide](../guides/triggers.md)).

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

See [Deployment → systemd](../deployment/systemd.md) for the full unit reference.

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

- [Concepts → Workflows](../concepts/workflows.md) — how steps compose, what the typed context gives you. <!-- @planned -->
- [Concepts → Permissions](../concepts/permissions.md) — the default-deny model, how to widen safely with profiles.
- [Concepts → Agents](../concepts/agents.md) — agent definitions in markdown. <!-- @planned -->
- [Recipes](../recipes/) — complete examples of long-running and HTTP-triggered patterns.
- [CLI reference](../reference/cli.md) <!-- @planned --> and [HTTP reference](../reference/http.md). <!-- @planned -->

## Common gotchas

**"Permission denied: tool X"** — agent tried to use a tool not in `permissions.allowedTools`. Add the tool id explicitly. Resist the urge to use `*` — narrow allow-lists are the security tenet at work.

**"Backend X not registered"** — your `skelm.config.ts` has no entry for the backend name. Add it under `backends:` and set `backend:` on the workflow or step.

**"Gateway not reachable"** — `skelm` CLI commands that need a running gateway look for one at `SKELM_GATEWAY_URL`, then `~/.skelm/gateway.json`, then `http://127.0.0.1:4000`. Start it with `skelm gateway start`, or run the workflow locally with no gateway running and skelm will spin up an in-process one for the duration.

**"Schema validation failed"** — input did not match the workflow's `input` schema. Check `skelm describe <workflow>` for the expected shape.
