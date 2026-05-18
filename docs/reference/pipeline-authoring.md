# Pipeline Authoring Reference

## Builders

All builders are exported from `'skelm'` (or `'@skelm/core'`).

### `pipeline(def)`

```ts
pipeline({
  id: string                                  // required; stable, kebab-case
  description?: string
  version?: string
  input?: SkelmSchema<TInput>                 // optional; validated at run start when present
  output?: SkelmSchema<TOutput>               // optional; validated after finalize
  steps: Step[]                               // ordered; run sequentially
  finalize?: (ctx: Context<TInput>) => TOutput | Promise<TOutput>
})
```

`SkelmSchema` is structurally compatible with Zod schemas; importing zod and passing `z.object({...})` works.

### `code(def)` — deterministic step

```ts
code({
  id: string
  // Exactly one of `run` or `module` is required.
  run?: (ctx: Context) => TOutput | Promise<TOutput>
  module?: string                 // path to a .ts/.js file exporting the run function
  export?: string                 // export name from `module` (default: 'default')
  permissions?: AgentPermissions  // required to call `ctx.exec(...)`
  secrets?: string[]
  retry?: RetryPolicy
})
```

Access prior step outputs: `ctx.steps['step-id']` (cast to the output type). Access run metadata: `ctx.run.runId`, `ctx.run.pipelineId`, `ctx.run.startedAt`.

#### Loading the run function from a file

Use `module:` to keep the step's body in its own file. Paths resolve relative to the pipeline file's directory (the CLI sets that automatically; programmatic callers can pass `pipeline({ baseDir, ... })`).

```ts
// steps/enrich.ts
export default async function enrich(ctx) {
  return { enriched: true }
}

// pipeline.ts
code({ id: 'enrich', module: './steps/enrich.ts' })
```

Imperative loads from inside `run` are also supported — call `loadTsModule` from `@skelm/core` so transpilation matches the CLI loader.

#### Spawning external executables — `ctx.exec(...)`

`code()` steps can invoke binaries, Python scripts, or Bash scripts via `ctx.exec`. The call is gated by `permissions.allowedExecutables` on the step (default-deny — omitting the field denies every call):

```ts
code({
  id: 'render',
  permissions: { allowedExecutables: ['python3'] },
  run: async (ctx) => {
    const r = await ctx.exec!({ python: './scripts/render.py', args: ['--out', 'tmp/'] })
    if (r.exitCode !== 0) throw new Error(r.stderr)
    return r.stdout
  },
})
```

`ctx.exec` request fields:

- `command` — bare name or absolute path. Mutually exclusive with `python` / `bash`.
- `python` — runs `$SKELM_PYTHON` (default `python3`) with the script as the first argv.
- `bash` — runs `$SKELM_BASH` (default `bash`) with the script as the first argv.
- `args`, `cwd`, `env`, `stdin` — passed through to the child.
- `timeoutMs` — kills with `SIGTERM` then `SIGKILL` after a 5s grace; result reports `timedOut: true`.
- `throwOnNonZero` — when true, a non-zero exit throws; default is to return the result.

The allowlist is checked against the **basename of the resolved binary** (`git`, `python3`, `bash`), not the user's input. Spawns never go through `shell: true`. See [permissions.md](./permissions.md#code-step-permissions) for the security model.

### `llm(def)` — single-shot inference

```ts
llm({
  id: string
  prompt: string | ((ctx: Context) => string)
  system?: string | ((ctx: Context) => string)
  backend?: string                // overrides config default
  model?: string
  output?: ZodSchema<TOutput>    // structured output
  temperature?: number
  maxTokens?: number
  retry?: RetryPolicy
})
```

### `agent(def)` — full agentic loop

See [agent-step.md](agent-step.md) for the full reference.

### `parallel(def)` — concurrent children

```ts
parallel({
  id: string
  steps: Step[]                       // must have unique ids within this block
  waitFor?: 'all' | 'any' | { atLeast: number }   // default: 'all'
  onError?: 'fail' | 'continue' | 'partial'        // default: 'fail'
})
```

Output is an object keyed by child step id. Access via `ctx.steps['parallel-id']`.

### `forEach(def)` — map over a collection

```ts
forEach({
  id: string
  items: (ctx: Context) => readonly unknown[]
  step: (item: unknown, index: number) => Step
  concurrency?: number              // default: unbounded
})
```

Output is an array of child step outputs in order.

### `branch(def)` — discriminator-driven routing

```ts
branch({
  id: string
  on: (ctx: Context) => string      // returns one of the case keys
  cases: Record<string, Step>
  default?: Step
})
```

### `loop(def)` — bounded iteration

```ts
loop({
  id: string
  while: (ctx: Context) => boolean | Promise<boolean>
  maxIterations: number             // required; prevents infinite loops
  step: Step
})
```

### `wait(def)` — pause until resumed

```ts
wait({
  id: string
  message?: string | ((ctx: Context) => string)
  timeoutMs?: number
  output?: ZodSchema<TOutput>
})
```

Resume via `POST /runs/:id/resume` on the gateway HTTP surface.

### `pipelineStep(def)` — nested pipeline

```ts
pipelineStep({
  id: string
  pipeline: Pipeline<TInput, TOutput>
  input?: TInput | ((ctx: Context) => TInput)
})
```

### `idempotent(def)` — cached step

```ts
idempotent({
  id: string
  key: string | ((ctx: Context) => string)    // cache key
  step: Step
  ttlMs?: number                               // cache TTL; default: unlimited
})
```

---

## Multi-step example

```ts
import { code, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'multi-step',
  input: z.object({ task: z.string().min(1) }),
  output: z.object({ report: z.string() }),
  steps: [
    code({
      id: 'parse',
      run: (ctx) => ({ task: (ctx.input as { task: string }).task.trim() }),
    }),
    code({
      id: 'summarize',
      run: (ctx) => {
        const { task } = ctx.steps['parse'] as { task: string }
        return { summary: `Summary of: ${task}` }
      },
    }),
  ],
  finalize: (ctx) => {
    const { task } = ctx.steps['parse'] as { task: string }
    const { summary } = ctx.steps['summarize'] as { summary: string }
    return { report: `${task}: ${summary}` }
  },
})
```

---

## RetryPolicy

```ts
interface RetryPolicy {
  maxAttempts: number             // total attempts including first
  delayMs?: number                // base delay between retries (ms)
  backoffMultiplier?: number      // exponential multiplier; default 1 (linear)
}
```

---

## Context shape

```ts
interface Context<TInput = unknown> {
  input: TInput
  steps: Record<string, unknown>    // keyed by step id
  run: RunMetadata                  // runId, pipelineId, startedAt
}
```

Cast step outputs when accessing: `ctx.steps['my-step'] as MyType`.
