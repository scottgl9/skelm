# @skelm/core

Runtime, types, and builders for [skelm](https://github.com/scottgl9/skelm).

This is the package every skelm workflow imports from (transitively, via the [`skelm`](../skelm/README.md) meta package). It contains:

- The public type surface — `Pipeline`, `Step`, `Context`, `Run`, `RunMetadata`, `StepResult`, `RunStatus`, etc.
- Builders — `pipeline()`, `code()`, `llm()`, `agent()`, `parallel()`, `forEach()`, `branch()`, `loop()`, `pipelineStep()`.
- The sequential `runPipeline()` runner with `AbortSignal` cancellation, finalize / last-step-adoption output resolution, and structured error capture.
- Standard-schema bridge for input/output validation. Zod is the documented default; any standard-schema-compatible validator works.
- The default-deny `AgentPermissions` model + `TrustEnforcer` for agent step gating (used in upcoming agent-step milestones).
- The `EventBus` and `RunEvent` union for observability.

## Install

You almost never install this directly. Customers install [`skelm`](../skelm/README.md), which re-exports everything here.

```sh
npm i skelm
```

```ts
import { code, pipeline, runPipeline } from 'skelm'
// equivalent to
import { code, pipeline, runPipeline } from '@skelm/core'
```

## At a glance

```ts
import { code, pipeline, runPipeline } from '@skelm/core'
import { z } from 'zod'

const wf = pipeline({
  id: 'sum',
  input:  z.object({ a: z.number(), b: z.number() }),
  output: z.object({ sum: z.number() }),
  steps: [
    code({
      id: 'add',
      run: (ctx) => {
        const { a, b } = ctx.input as { a: number; b: number }
        return { sum: a + b }
      },
    }),
  ],
})

const run = await runPipeline(wf, { a: 2, b: 3 })
console.log(run.output) // { sum: 5 }
```

## Public exports

```ts
export {
  // builders
  pipeline, code, llm, agent, parallel, forEach, branch, loop, pipelineStep,
  // runtime
  runPipeline, type RunOptions,
  // types
  type Pipeline, type Step, type CodeStep,
  type Context, type Run, type RunMetadata, type StepResult,
  type RunId, type StepId, type StepKind, type RunStatus, type StepStatus,
  type SerializedError,
  // schemas
  type SkelmSchema, SchemaValidationError,
  // events
  EventBus, type RunEvent, type RunEventType, type EventListener, terminalEventTypeFor,
  // permissions
  resolvePermissions, TrustEnforcer,
  type AgentPermissions, type ResolvedPolicy, type ResolvedToolMatcher,
  type ToolMatcher, type NetworkPolicy, type ApprovalPolicy,
  type PermissionDimension, type PermissionDenialReason, type EnforceDecision,
  // errors
  StepError, RunCancelledError, serializeError,
}
```

## Stability

`@skelm/core` is `0.x` — APIs may change between minor versions until v1. Anything exported from `index.ts` is part of the public API; submodule paths are internal and may move.

## License

MIT.
