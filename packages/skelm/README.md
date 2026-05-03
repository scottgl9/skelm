# skelm

The top-level meta package for [skelm](https://github.com/scottgl9/skelm) — a TypeScript framework for secure, agentic, long-running workflows.

This is what customers install. It re-exports everything from [`@skelm/core`](../core/README.md) and ships the `skelm` CLI bin sourced from [`@skelm/cli`](../cli/README.md).

## Install

```sh
npm i -g skelm
skelm --help
```

For a project-local install:

```sh
npm i skelm zod
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
      run: (ctx) => ({ greeting: `hello, ${(ctx.input as { name: string }).name}` }),
    }),
  ],
})
```

```sh
skelm run my.workflow.ts --input '{"name":"world"}'
# → {"greeting":"hello, world"}
```

See the project [README](../../README.md) for the full pitch and the [docs](../../docs/) for guides, recipes, and reference.

## What is exported

Everything from `@skelm/core`:

- Builders — `pipeline()`, `code()`
- Runtime — `runPipeline()`, `RunOptions`
- Types — `Pipeline`, `Step`, `Context`, `Run`, `StepResult`, `RunMetadata`, etc.
- Schemas — `SkelmSchema`, `SchemaValidationError`
- Events — `EventBus`, `RunEvent`, `RunEventType`
- Permissions — `AgentPermissions`, `TrustEnforcer`, `resolvePermissions`
- Errors — `StepError`, `RunCancelledError`, `serializeError`

The server surface (when added) is imported from `@skelm/server` explicitly so the meta package stays small for users who only need the authoring + runner surface.

## Stability

`0.x` — APIs may change between minor versions until v1.

## License

MIT.
