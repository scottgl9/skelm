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
  timeoutMs?: number              // aborts ctx.signal and rejects with StepTimeoutError
  workspace?: WorkspaceConfig | ((ctx) => WorkspaceConfig) // provisions ctx.workspace
  continueOnError?: boolean       // failure is recorded but pipeline continues
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

When `timeoutMs` is set, the runtime chains an `AbortController` to `ctx.signal` and races `run()` against the budget. Authors that ignore `ctx.signal` still lose the race — the wrapping promise rejects with `StepTimeoutError` so a runaway code step cannot block the gateway.

### `infer(def)` — single-shot inference

```ts
infer({
  id: string
  prompt:
    | string
    | readonly ContentPart[]                          // multimodal: text + image parts
    | ((ctx: Context) => string | readonly ContentPart[])
  system?: string | ((ctx: Context) => string)
  backend?: string                // overrides config default
  model?: string
  output?: ZodSchema<TOutput>    // structured output
  temperature?: number
  maxTokens?: number
  retry?: RetryPolicy
})
```

Multimodal prompts use `ContentPart` blocks. Build them with the
`textPart` / `imagePart` / `imagePartFromFile` helpers:

```ts
import { imagePartFromFile, textPart, infer } from 'skelm'

infer({
  id: 'describe',
  backend: 'anthropic',
  prompt: async (ctx) => [
    textPart('Describe what is on screen.'),
    await imagePartFromFile(ctx.steps['capture'].path),
  ],
})
```

Backends declare `capabilities.vision` truthfully. Submitting an image part
to a backend that does not declare vision fails at step start with
`BackendCapabilityError` — route image prompts to a vision-capable backend
(the first-party `anthropic` and `openai` backends both support vision).

### Binary artifacts via `ctx.artifacts`

Steps can persist binary outputs (screenshots, evidence files, etc.) keyed
by `{runId, stepId, name}`:

```ts
code({
  id: 'capture',
  run: async (ctx) => {
    const png = await captureScreen()                  // your driver
    if (ctx.artifacts === undefined) {
      throw new Error('ctx.artifacts is unavailable in this runtime context')
    }
    const desc = await ctx.artifacts.put({
      name: 'screen.png',
      mimeType: 'image/png',
      data: png,                                       // Uint8Array | string
    })
    return { artifactId: desc.artifactId }
  },
})
```

Each put publishes a `tool.result` event (`tool: 'artifacts.put'`) carrying
descriptor metadata only — the bytes never appear in the event log. A
default per-run quota of 256 MiB (`DEFAULT_ARTIFACT_QUOTA_BYTES`) is
enforced; exceeding it throws `ArtifactQuotaExceededError` and writes
nothing. Retrieve with `ctx.artifacts.get({ runId, artifactId })`; list
all artifacts for the current run with `ctx.artifacts.list()`.

To hand an artifact to a filesystem-based tool, materialize it into the
current step workspace:

```ts
code({
  id: 'export-report',
  workspace: { mode: 'persistent', name: 'reports' },
  run: async (ctx) => {
    if (ctx.artifacts === undefined) {
      throw new Error('ctx.artifacts is unavailable in this runtime context')
    }
    const desc = await ctx.artifacts.put({
      name: 'report.txt',
      mimeType: 'text/plain',
      data: 'hello',
    })
    const file = await ctx.artifacts.materialize(desc, {
      path: 'exports/report.txt',
      overwrite: true,
    })
    return { path: file.path, bytesWritten: file.bytesWritten }
  },
})
```

`materialize()` requires `ctx.workspace`; it never writes relative to the
process cwd. The target path must be relative, must stay inside the workspace,
and cannot escape through `..` segments or symlinks. The materialization event
is also descriptor-only (`artifactId`, `name`, `mimeType`, `size`, relative
`path`, and `bytesWritten`) so raw artifact bytes do not enter the run log.
Artifact names are single safe file names; use the materialization `path`
option when a nested export path is needed.

### Read-only workflow assets via `ctx.assets`

Use `ctx.assets` for bundled, versioned inputs such as prompts, templates,
rules, schemas, and fixtures. Asset paths are relative to the pipeline
`baseDir` that the workflow loader sets from the workflow file directory;
programmatic pipelines should set `pipeline({ baseDir, ... })` for the same
stable behavior. Lookups do not depend on `process.cwd()` after the run starts.

```ts
code({
  id: 'load-prompt',
  run: async (ctx) => {
    const prompt = await ctx.assets.getText('assets/review-prompt.md')
    const rubric = await ctx.assets.getJson<{ labels: string[] }>('assets/rubric.json')
    const fixture = await ctx.assets.getBytes('assets/fixtures/input.bin')
    return { prompt, rubric, fixtureSize: fixture.byteLength }
  },
})
```

Available helpers:

- `ctx.assets.getText(path)` — UTF-8 text.
- `ctx.assets.getJson<T = unknown>(path)` — parsed JSON.
- `ctx.assets.getBytes(path)` — raw bytes as `Uint8Array`.
- `ctx.assets.exists(path)` — `false` for missing files or paths outside the asset root.
- `ctx.assets.list(prefix?)` — sorted recursive file paths under the asset root.

Assets are read-only and scoped to the workflow/package root. Absolute paths,
backslashes, `..` traversal, and symlink escapes are denied. Use
`ctx.artifacts` for run outputs and `ctx.workspace` for mutable working files.

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

## Conditional execution — `when`

Every top-level step accepts an optional `when: (ctx) => boolean | Promise<boolean>`
predicate. When it returns `false`, the step is skipped: its handler does not
run, its result is recorded with `status: 'skipped'` and `output: undefined`,
and a `step.skipped` event is published. Later steps reading the skipped
step's output via `ctx.get(id)` see `undefined`.

```ts
agent({
  id: 'review',
  prompt: 'Review the diff.',
  when: (ctx) => ctx.get<{ authorIsBot: boolean }>('classify')?.authorIsBot === false,
})
```

A predicate that throws is treated as a step failure (the run fails the same
way as if the step body had thrown). For conditional dispatch the recommended
pattern is `when` over `branch({ cases: { run, skip } })`.

The predicate is consulted on top-level steps only; predicates on steps
nested inside `parallel()`, `forEach()`, `branch()`, or `loop()` are not
currently evaluated by the runtime.

---

## `continueOnError` — soft step failures

Every top-level step builder (`code`, `infer`, `agent`, `parallel`, `forEach`,
`branch`, `loop`, `wait`, `pipelineStep`, `invoke`, `idempotent`) accepts an
optional `continueOnError?: boolean`. Default `false`.

When `true`, a thrown failure in the step is recorded as a failed `StepResult`
(observable in `ctx.steps[id]` as `undefined` and in the run's `stepResults`),
but the runner moves on to the next step instead of aborting. The run's final
status is still `'failed'` and `runError` is set to the most recent
`continueOnError` failure if no later step fails.

`RunCancelledError` always aborts the run regardless of `continueOnError` —
cancellation is not a soft failure.

```ts
pipeline({
  id: 'soft-failure-demo',
  steps: [
    code({ id: 'a', run: () => 1 }),
    code({ id: 'b', continueOnError: true, run: () => { throw new Error('boom') } }),
    code({ id: 'c', run: () => 3 }),  // still runs
  ],
})
```

Used by the `check()` test-authoring helper (see `@skelm/core/testing`) to
keep a failing assertion from short-circuiting the rest of a test section.

## `workspace` on `code()`

`code()` accepts the same `workspace?: WorkspaceConfig | ((ctx) => WorkspaceConfig)`
field as `agent()`, with identical provisioning and cleanup semantics. See
[agent-step.md](./agent-step.md#workspace-modes) for the full lifecycle. The handle
is exposed as `ctx.workspace` inside the step's `run`, and the runner releases
it on run completion according to `cleanup`.

```ts
code({
  id: 'scratch',
  workspace: { mode: 'ephemeral', cleanup: 'on-run-end' },
  run: async (ctx) => {
    const scratchPath = ctx.workspace!.path
    // ... use scratchPath ...
    return { scratchPath }
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
  state: State                      // typed KV + append-only streams
  assets: AssetHost                 // read-only workflow/package assets
  threads: ThreadHost               // see "Threaded conversations"
}
```

Cast step outputs when accessing: `ctx.steps['my-step'] as MyType`.

## Durable application state — `ctx.state`

`ctx.state` is workflow-owned durable application state, not just run-local
scratch data. When the gateway uses SQLite or Postgres run storage, values
survive process restart and later runs with the same namespace can read them.
The in-memory store implements the same API for tests and local embedding, but
only lasts for the lifetime of that store instance.

```ts
code({
  id: 'checkpoint',
  run: async (ctx) => {
    const last = (await ctx.state.get<number>('cursor')) ?? 0
    const next = last + 1
    await ctx.state.set('cursor', next)
    await ctx.state.append('decisions', { from: last, to: next })
    return { cursor: next }
  },
})
```

State scopes:

| Scope           | Namespace owner                          | Use for                                                                                       |
| --------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pipeline`      | The pipeline id. This is the default.    | Cursors, checkpoints, and idempotency keys shared by every step and run of one pipeline.       |
| `step`          | The pipeline id plus current step id.    | Step-private state that later steps should not read accidentally.                              |
| `pipeline+name` | A stable explicit name.                  | Shared package/application state used by multiple pipelines.                                   |

Use `ctx.state.scope(config)` when one step needs more than its default scope:
The derived handle does not inherit the current `StateConfig`; only the
pipeline id and current step id carry over. Requesting `step` scope outside a
step context, such as from `finalize`, fails with `StateConfigError`.

```ts
code({
  id: 'sync',
  state: { scope: 'step' },
  run: async (ctx) => {
    await ctx.state.set('last-batch-size', 12) // step-private

    const shared = ctx.state.scope({
      scope: 'pipeline+name',
      name: 'github-sync',
    })
    await shared.cas('cursor', undefined, { page: 1 })
  },
})
```

Concurrency:

Use `cas(key, expected, next)` for cursors, locks, and reconciliation records
that concurrent runs may update. SQLite and Postgres perform CAS atomically.
Plain `set()` is last-writer-wins. `append()` writes an ordered journal entry
and `read(stream, { since, limit })` replays entries in store order.

TTL:

`set(key, value, { ttlMs })` stores expiring entries. Expired entries are
pruned lazily when they are read or listed, so TTL is a retention hint rather
than a scheduled deletion guarantee.

## Threaded conversations — `ctx.threads`

For PR / issue / Slack threads the runtime exposes a small helper that keeps
"last-seen" markers and appended comments in a dedicated namespace so they
don't collide with regular `ctx.state` keys.

```ts
const t = ctx.threads.get({ kind: 'github-pr', key: `${owner}/${repo}#${number}` })

// Note when a new comment arrives:
await t.appendComment(comment.id, comment)

// On the next run, replay only what we haven't seen:
const lastSeen = await t.lastSeen()
for await (const c of t.unseenSince(lastSeen)) {
  await handle(c.comment)
}
await t.markSeen(latestId)
```

`kind` and `key` are opaque to the framework — `key` is whatever string
uniquely identifies one thread within `kind`. By convention,
`github-pr` / `github-issue` use `${owner}/${repo}#${number}` and `slack`
uses `${channelId}:${threadTs}`. State persists for as long as the
configured `StateStore` retains it.

Replaces hand-managed `last-comment-seen:<repo>#<n>` keys in pipelines that
track ongoing PR / issue conversations.
