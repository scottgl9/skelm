# @skelm/core

> Runtime, types, and builders for [skelm](https://github.com/scottgl9/skelm) — secure, agentic, long-running workflows in TypeScript.

[![npm](https://img.shields.io/npm/v/@skelm/core)](https://www.npmjs.com/package/@skelm/core)

Part of [skelm](https://github.com/scottgl9/skelm).

## Install

You usually don't install this directly. End users install [`skelm`](https://www.npmjs.com/package/skelm), which re-exports everything here. Install `@skelm/core` directly when building libraries, plugins, or backends on top of skelm.

```bash
npm install @skelm/core zod
```

```ts
import { pipeline, code, runPipeline } from '@skelm/core'
// equivalent to
import { pipeline, code, runPipeline } from 'skelm'
```

## Quick Start

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

## Features

- **Three step kinds** — `code()` for deterministic logic, `llm()` for one-shot inference, `agent()` for full agent loops. None is a wrapper around another.
- **Native control flow** — `parallel()`, `forEach()`, `branch()`, `loop()`, `wait()`, and nested `pipelineStep()`.
- **Standard Schema bridge** — Zod is the documented default; any Standard Schema-compatible validator works for input/output validation.
- **Default-deny permission model** — `AgentPermissions` and `TrustEnforcer` for agent step gating. Optional fields default to deny.
- **Typed `EventBus`** — `RunEvent` union covers run lifecycle, step lifecycle, agent turns, tool calls, decisions, and errors.
- **Sequential runner** — `runPipeline()` with `AbortSignal` cancellation, finalize / last-step-adoption output resolution, and structured error capture.
- **Persistent state primitives** — `ctx.state` for typed KV across runs; append-only journals for "what did the agent decide and why."

## Public exports

```ts
export {
  // builders
  pipeline, code, llm, agent, parallel, forEach, branch, loop, wait, pipelineStep,
  // runtime
  runPipeline, Runner, type RunOptions,
  // types
  type Pipeline, type Step, type CodeStep,
  type Context, type Run, type RunMetadata, type StepResult,
  type RunId, type StepId, type StepKind, type RunStatus, type StepStatus,
  type RetryPolicy,
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
  StepError, RunCancelledError, WaitTimeoutError, serializeError,
}
```

A `@skelm/core/testing` subpath is also published with helpers for unit-testing pipelines.

## Stability

`0.x` — APIs may change between minor versions until v1. Anything exported from `index.ts` is part of the public API; submodule paths are internal and may move.

## Contributing

See the [contributing guide](https://github.com/scottgl9/skelm/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE)
