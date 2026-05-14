<h1 align="center">skelm</h1>

<p align="center">
  <strong>Build secure, agentic, long-running workflows in TypeScript. Run them anywhere Node runs.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/skelm"><img src="https://img.shields.io/npm/v/skelm" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
</p>

---

This is the meta-package that ships the `skelm` CLI bin and re-exports the runtime. It depends on:

- **[@skelm/core](https://www.npmjs.com/package/@skelm/core)** — runtime, types, builders, permissions, event bus
- **[@skelm/cli](https://www.npmjs.com/package/@skelm/cli)** — command-line interface and programmatic primitives

For the long-running orchestrator (HTTP, registries, audit, agent lifecycle), install [`@skelm/gateway`](https://www.npmjs.com/package/@skelm/gateway) separately so this meta package stays small for users who only need the authoring + runner surface.

## Install

```bash
npm install -g skelm
skelm init my-bot && cd my-bot
skelm run workflows/hello.workflow.ts
```

For project-local use:

```bash
npm install skelm zod
```

## Quickstart

```ts
// my.workflow.ts
import { code, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'hello',
  input:  z.object({ name: z.string() }),
  output: z.object({ greeting: z.string() }),
  steps: [
    code({
      id: 'greet',
      run: (ctx) => ({ greeting: `hello, ${ctx.input.name}` }),
    }),
  ],
})
```

```bash
skelm run my.workflow.ts --input '{"name":"world"}'
# → {"greeting":"hello, world"}
```

## Usage

```bash
skelm init                            # Scaffold a project
skelm run workflow.ts                 # Run a workflow once
skelm run workflow.ts --events json   # Stream JSON events to stderr
skelm schedule add workflow.ts --cron '0 9 * * 1-5'   # Schedule on a cron
skelm schedule list                   # List schedules
skelm history --last 20               # Recent runs
skelm gateway start                   # Start the long-running orchestrator (foreground)
skelm gateway status                  # Inspect a running gateway
skelm gateway stop                    # Stop it
skelm gateway install --systemd       # Install as a systemd user service
```

## What is exported

Everything from `@skelm/core`:

- **Builders** — `pipeline()`, `code()`, `llm()`, `agent()`, `parallel()`, `forEach()`, `branch()`, `loop()`, `wait()`, `pipelineStep()`
- **Runtime** — `runPipeline()`, `Runner`, `RunOptions`
- **Types** — `Pipeline`, `Step`, `Context`, `Run`, `StepResult`, `RunMetadata`, `RunStatus`, `StepStatus`, `RetryPolicy`, ...
- **Schemas** — `SkelmSchema`, `SchemaValidationError` (Standard Schema-compatible; Zod is the documented default)
- **Events** — `EventBus`, `RunEvent`, `RunEventType`
- **Permissions** — `AgentPermissions`, `TrustEnforcer`, `resolvePermissions`
- **Errors** — `StepError`, `RunCancelledError`, `WaitTimeoutError`, `serializeError`

## Learn more

Full documentation, examples, and source code:

**[github.com/scottgl9/skelm](https://github.com/scottgl9/skelm)**

## Stability

`0.x` — APIs may change between minor versions until v1.

## License

[MIT](LICENSE)
