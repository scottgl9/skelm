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

`skelm run` is the local one-shot path for executing a workflow immediately. It loads the workflow, resolves the input, runs the pipeline, and prints the final JSON output to stdout.

It does not leave a cron, webhook, interval, poll, or queue trigger registered. Long-running triggers are hosted by `skelm gateway start`.

Want to see the run's events?

```sh
skelm run workflows/hello.workflow.ts --input '{"name":"world"}' --events json 2> events.log
cat events.log
```

### What happens during a one-shot run

A one-shot run is short-lived, but it still creates a normal run record and emits lifecycle events you can inspect later.

```text
CLI input
  ↓
load workflow + config
  ↓
resolve JSON input
  ↓
create run id
  ↓
run.created / run.started
  ↓
input schema validation
  ↓
step.start → run step → step.complete
      └──────── step.error → run.failed
  ↓
finalize or use last step output
  ↓
output schema validation
  ↓
run.completed → final JSON on stdout
```

The CLI resolves JSON from `--input`, `--input-file`, or stdin before the runner starts. After that, schema validation happens early in the run, so validation failures can still have a run id, events, and history.

Progress and event output goes to stderr so stdout can stay reserved for the workflow's final JSON output.

### Visualize the workflow shape

To see the declared step graph instead of one run's event stream:

```sh
skelm describe workflows/hello.workflow.ts --format mermaid
```

The lifecycle above shows what happens during a run. `skelm describe --format mermaid` shows the workflow structure: steps, edges, and permissions.

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

The gateway listens on `127.0.0.1:14738` by default and runs your schedules. Press Ctrl-C to stop with a graceful drain.

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
curl http://127.0.0.1:14738/runs?limit=10
curl http://127.0.0.1:14738/runs/<runId>
```

## What's next

- [Concepts → Permissions](../concepts/permissions.md) — the default-deny model, how to widen safely with profiles.
- [Concepts → Coding agents](../concepts/coding-agents.md) — how skelm's agent runtime composes with backends.
- [Concepts → Registries](../concepts/registries.md) — workflow, skill, agent, and MCP-server registries.
- [Recipes](../recipes/README.md) — complete examples of long-running and HTTP-triggered patterns.
- [CLI reference](../reference/cli.md) and [HTTP reference](../reference/http.md).

## Troubleshooting and FAQ

### `invalid JSON from --input`

Pass valid JSON as one shell argument:

```sh
skelm run workflows/hello.workflow.ts --input '{"name":"world"}'
```

For larger inputs, use a file:

```sh
skelm run workflows/hello.workflow.ts --input-file input.json
```

### `Schema validation failed`

The value passed to `--input`, `--input-file`, or stdin does not match the workflow's `input` schema.

Check the workflow definition first. In the scaffolded project, the example input expects:

```ts
z.object({ name: z.string().min(1) })
```

### Why did the run fail before any step started?

Input schema validation runs before the first step. If the input is invalid, skelm emits a run failure without any `step.start` events.

### `Permission denied: tool X`

An agent tried to use a tool that was not listed in the step permissions.

Add the narrowest permission that actually belongs in the workflow. Avoid widening everything at once; default-deny is the point.

### `Backend X not registered`

The workflow or step references a backend id that is not configured.

Register the backend in `skelm.config.ts`, then make sure the step's `backend:` value uses the same id.

### Do I need the gateway for `skelm run`?

No. `skelm run` is the local one-shot path.

You need the gateway for long-running schedules, webhooks, queues, HTTP inspection, approvals, sessions, and other persistent concerns.

### I added a schedule, but nothing fires

Start the gateway:

```sh
skelm gateway start
```

Schedules, webhooks, pollers, and queue sources need the long-running gateway process to stay alive.

### Why do events go to stderr?

The final workflow output is written to stdout. Progress lines and JSON event streams are written to stderr so you can pipe the final result without mixing it with logs.
