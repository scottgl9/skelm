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

### Deterministic pipeline (`code`)

```ts
import { code, pipeline, runPipeline } from '@skelm/core'
import { z } from 'zod'

const wf = pipeline({
  id: 'normalize-event',
  input:  z.object({ type: z.string(), title: z.string() }),
  output: z.object({ summary: z.string(), priority: z.enum(['high', 'normal']) }),
  steps: [
    code({
      id: 'build-summary',
      run: (ctx) => ({
        summary:  `[${ctx.input.type.toUpperCase()}] ${ctx.input.title}`,
        priority: ctx.input.type === 'incident' ? ('high' as const) : ('normal' as const),
      }),
    }),
  ],
})

const run = await runPipeline(wf, { type: 'incident', title: 'DB primary unreachable' })
console.log(run.output)
// { summary: '[INCIDENT] DB primary unreachable', priority: 'high' }
```

### LLM inference step (`llm`)

```ts
import { code, llm, pipeline, runPipeline } from '@skelm/core'
import { createOpenAIBackend } from '@skelm/core'
import { BackendRegistry } from '@skelm/core'
import { z } from 'zod'

const openai = createOpenAIBackend({
  id: 'openai',
  apiKey: { secret: 'OPENAI_API_KEY' },   // resolved from OPENAI_API_KEY env var
  model:  'gpt-4o-mini',
})

const backends = new BackendRegistry()
backends.register(openai)

const wf = pipeline({
  id: 'classify-event',
  input:  z.object({ summary: z.string() }),
  output: z.object({ label: z.string(), reasoning: z.string() }),
  steps: [
    llm({
      id: 'classify',
      backend: 'openai',
      prompt: (ctx) => `Classify the following event as "incident", "alert", or "info":\n\n${ctx.input.summary}`,
      output: z.object({
        label:     z.enum(['incident', 'alert', 'info']),
        reasoning: z.string(),
      }),
    }),
  ],
})

const run = await runPipeline(wf, { summary: '[INCIDENT] DB primary unreachable' }, { backends })
console.log(run.output)
// { label: 'incident', reasoning: '...' }
```

### Agent step (`agent`) with a skill

```ts
import { agent, code, pipeline, runPipeline } from '@skelm/core'
import { createPiSdkBackend } from '@skelm/pi'
import { BackendRegistry } from '@skelm/core'
import { z } from 'zod'

// Skills are Markdown files discovered from registries.skills in skelm.config.ts.
// At runtime the skill body is injected into the agent's system prompt.
const pi = createPiSdkBackend({ id: 'pi' })
const backends = new BackendRegistry()
backends.register(pi)

const wf = pipeline({
  id: 'triage-issue',
  input:  z.object({ title: z.string(), body: z.string() }),
  output: z.object({ label: z.string(), reasoning: z.string() }),
  steps: [
    agent({
      id: 'classify',
      backend: 'pi',
      skills: ['triage-guide'],           // inject the skill at runtime
      prompt: (ctx) =>
        `Triage this issue and return JSON {label, reasoning}:\nTitle: ${ctx.input.title}\n${ctx.input.body}`,
      permissions: {
        allowedTools:       [],
        allowedExecutables: [],
        allowedMcpServers:  [],
        allowedSkills:      ['triage-guide'],
        networkEgress:      'deny',
        fsRead:             [],
        fsWrite:            [],
      },
      output: z.object({ label: z.string(), reasoning: z.string() }),
      maxTurns: 3,
    }),
  ],
})

const run = await runPipeline(wf, { title: 'Login fails on Safari', body: '...' }, { backends })
console.log(run.output)
// { label: 'bug', reasoning: '...' }
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
