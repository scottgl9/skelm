# Quickstart

Build, run, and schedule your first skelm workflow in five minutes.

## TL;DR

```sh
npm i -g skelm
skelm init my-bot && cd my-bot && npm install
skelm run workflows/hello.workflow.mts --input '{"name":"world"}'
```

That's a code-only workflow. To add an agent step, see [Add an agent step](./add-agent.md) once the basics are working.

## Prerequisites

- Node.js 22.18+
- A terminal
- (Optional, for the LLM example) An OpenAI-compatible endpoint and API key (any vendor that speaks the OpenAI Chat Completions protocol)
- (Optional, for the agent example) The pi coding-agent SDK: `npm install @earendil-works/pi-coding-agent`. Pi reads its provider/model from `~/.pi/auth.json` and `~/.pi/models.json` — see [pi's docs](https://github.com/mariozechner/pi) to point it at your model

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
│   └── hello.workflow.mts    # example: prints a greeting
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

## 3. Look at the example workflow

```ts
// workflows/hello.workflow.mts
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
skelm run workflows/hello.workflow.mts --input '{"name":"world"}'
```

Output:

```json
{"greeting":"hello, world"}
```

`skelm run` is the local one-shot path for executing a workflow immediately. It loads the workflow, resolves the input, runs the pipeline, and prints the final JSON output to stdout.

It does not leave a cron, webhook, interval, poll, or queue trigger registered. Long-running triggers are hosted by `skelm gateway start`.

Want to see the run's events?

```sh
skelm run workflows/hello.workflow.mts --input '{"name":"world"}' --events json 2> events.log
cat events.log
```

## 5. Schedule it

Run every five minutes:

```sh
skelm schedule add workflows/hello.workflow.mts \
  --cron '*/5 * * * *' \
  --input '{"name":"world"}' \
  --id hello-cron
```

Or fire on a webhook (the gateway must be running):

```sh
skelm schedule add workflows/hello.workflow.mts \
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

## 6. Run the gateway

For long-running schedules (cron, webhook, poll, queue) to fire continuously, start the gateway:

```sh
skelm gateway start
```

The gateway listens on `127.0.0.1:14738` by default and runs your schedules. Press Ctrl-C to stop with a graceful drain. It will also remind you to install it as a background service.

To install it as a persistent systemd user service that starts automatically on login and restarts on failure:

```sh
skelm gateway install
```

This writes the unit file, reloads systemd, and starts the service immediately. If user lingering is not enabled, you'll see a warning with the command to enable it so the service also starts at boot without a login session.

To view logs from the running service:

```sh
journalctl --user -u skelm-gateway -f
```

## 7. Inspect runs

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

- [Add an agent step](./add-agent.md) — install a backend and convert `hello` into an LLM-driven greeting.
- [Concepts → Permissions](../concepts/permissions.md) — the default-deny model, how to widen safely with profiles.
- [Concepts → Coding agents](../concepts/coding-agents.md) — how skelm's agent runtime composes with backends.
- [Concepts → Registries](../concepts/registries.md) — workflow, skill, agent, and MCP-server registries.
- [Recipes](../recipes/README.md) — complete examples of long-running and HTTP-triggered patterns.
- [CLI reference](../reference/cli.md) and [HTTP reference](../reference/http.md).

## Troubleshooting and FAQ

### `invalid JSON from --input`

Pass valid JSON as one shell argument:

```sh
skelm run workflows/hello.workflow.mts --input '{"name":"world"}'
```

For larger inputs, use a file:

```sh
skelm run workflows/hello.workflow.mts --input-file input.json
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
