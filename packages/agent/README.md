# @skelm/agent

> First-party native agent backend for [skelm](https://github.com/scottgl9/skelm) — runs a multi-turn LLM loop against any OpenAI-compatible endpoint, with permissions enforced **in-process** by skelm's own `TrustEnforcer`.

[![npm](https://img.shields.io/npm/v/@skelm/agent)](https://www.npmjs.com/package/@skelm/agent)

Part of [skelm](https://github.com/scottgl9/skelm).

No dependency on Pi, Opencode, or ACP. The agent loop, the tool surface, and the permission gating all live in this package. Capabilities advertised to skelm:

| Capability | Value |
|---|---|
| `prompt` | `true` — drives `infer()` steps via single-shot inference |
| `run` | `true` — drives `agent()` steps with multi-turn tool use |
| `mcp` | `true` — unknown tool names fall through to `ctx.mcpHost.invokeTool` |
| `skills` | `true` — `load_skill` is gated by `allowedSkills` |
| `toolPermissions` | `'native'` — every tool calls `TrustEnforcer` before its side effect |
| `streaming` | `true` — agent-loop turns stream over SSE (`stream: true`) and emit one `step.partial` event per content delta when the run has an event sink; without a sink the loop issues plain non-streaming requests |

## Install

```bash
npm install @skelm/agent
```

You also need an OpenAI-compatible chat-completions endpoint. Anything that speaks the Chat Completions shape works: OpenAI, OpenRouter, Anthropic via a proxy, [llama.cpp server](https://github.com/ggerganov/llama.cpp), [vLLM](https://github.com/vllm-project/vllm), [SGLang](https://github.com/sgl-project/sglang), [Ollama](https://ollama.ai) with `/v1`, etc.

## Quick start

```ts
// skelm.config.ts
import { defineConfig } from '@skelm/core'
import { createSkelmAgentBackend } from '@skelm/agent'

export default defineConfig({
  backends: { agent: 'native-agent', infer: 'native-agent' },
  instances: [
    createSkelmAgentBackend({
      id: 'native-agent',
      baseUrl: process.env.OPENAI_BASE_URL ?? 'http://localhost:8000',
      apiKey: process.env.OPENAI_API_KEY,
      model: 'qwen36',
    }),
  ],
  defaults: {
    permissions: {
      // default-deny across every dimension — opt in per step
      networkEgress: 'deny',
      allowedTools: [],
      allowedExecutables: [],
      allowedSkills: [],
      allowedMcpServers: [],
      fsRead: [],
      fsWrite: [],
    },
  },
})
```

```ts
// greet.pipeline.mts
import { agent, pipeline } from '@skelm/core'
import { z } from 'zod'

export default pipeline({
  id: 'greet',
  input: z.object({ name: z.string() }),
  output: z.object({ result: z.string() }),
  steps: [
    agent({
      id: 'reply',
      backend: 'native-agent',
      prompt: (ctx) => `Greet ${(ctx.input as { name: string }).name} in one sentence.`,
      maxTurns: 2,
      permissions: {
        allowedTools: [],
        allowedExecutables: [],
        allowedMcpServers: [],
        allowedSkills: [],
        fsRead: [],
        fsWrite: [],
        networkEgress: 'deny',
      },
    }),
  ],
  finalize: (ctx) => ({ result: JSON.stringify(ctx.steps.reply) }),
})
```

```bash
skelm run greet.pipeline.mts --input '{"name":"world"}'
```

## Options

```ts
createSkelmAgentBackend({
  id?: string            // backend id (default: 'agent')
  label?: string         // diagnostic label
  baseUrl: string        // OpenAI-compatible endpoint, e.g. 'http://localhost:8000'
  apiKey?: string        // sent as `Authorization: Bearer <key>` if provided
  headers?: Record<string, string> // extra LLM request headers, e.g. OpenRouter attribution
  model?: string         // default model when the step doesn't specify one
  timeoutMs?: number     // LLM HTTP timeout (default 300_000)
  sessionStore?: SessionStore // persist run() conversations; see Session lifecycle
  onPromptAssembled?: (info) => void // debug hook: assembled system prompt + tool names
  budget?: AgentBudget        // cumulative harness safety limits; see Budgets
  outputValidators?: OutputValidator[] // post-run text checks; see Validators
  toolValidators?: ToolValidator[]     // pre-dispatch tool checks; see Validators
})
```

## Budgets, validators, and metrics (harness safety limits)

These are **agent-harness** safety controls for the `run()` loop. They are *not* permission dimensions and *not* skelm's core HITL / oversight — they never widen anything; they only observe and, where configured, abort a run deterministically. Defaults leave every dimension unset (unbounded, unchanged behavior).

### Budgets

`budget?: AgentBudget` sets cumulative ceilings tracked across **all** turns of one `run()`:

| Field | Limits |
|---|---|
| `tokenBudget` | cumulative input + output tokens summed from each turn's `Usage` (distinct from the per-call `maxTokens` output cap and from `maxTurns`) |
| `maxCostUsd` | cumulative estimated USD cost (see cost note below) |
| `maxToolCalls` | total tool-call dispatches |
| `maxWallClockMs` | wall-clock elapsed since loop start |

When any ceiling is crossed the loop emits a `run.warning` (code `agent.budget.<dimension>`, observable in the event log) and then throws `AgentBudgetExceededError`, which carries `{ dimension, observed, limit }`. The check fires after each turn's usage is folded in and after each tool-call increment, so a runaway loop aborts promptly.

**Cost.** Estimated cost is derived from the model registry entry's `ModelCost` (`input`/`output` USD per 1K tokens) when the backend routes through a `registry`. In single-endpoint mode there is no pricing, so cost falls back to any upstream-reported `Usage.costUsd` (0 when neither is known — a priceless run never trips the cost budget).

```ts
createSkelmAgentBackend({
  registry,
  defaultModel: { provider: 'openrouter', id: 'openai/gpt-5.2' },
  budget: { tokenBudget: 200_000, maxCostUsd: 1.0, maxToolCalls: 40, maxWallClockMs: 120_000 },
})
```

### Validators

Validators are pure (sync or async) functions — **no LLM calls inside the harness**. Each returns `{ ok: true }` or `{ ok: false, reason, severity? }`. A **soft** failure (default) records a `run.warning` (code `agent.validator.<stage>`) and the run continues; a **hard** failure (`severity: 'hard'`) throws `AgentValidationError` (`{ stage, reason }`).

- `outputValidators?: OutputValidator[]` run once on the final assistant text: `(text, ctx) => ValidationResult`, where `ctx` carries `stopReason` and parsed `structured` (when an `outputSchema` was requested).
- `toolValidators?: ToolValidator[]` run before each tool dispatch — *after* the `TrustEnforcer` permission gate, as an extra harness check: `({ tool, args }) => ValidationResult`. A hard failure aborts before the tool executes.

Validators are distinct from `outputSchema` validation: the **runtime** still validates the step result against any declared `outputSchema` and surfaces `SchemaValidationError` on mismatch. Validators add harness-level checks on top.

```ts
createSkelmAgentBackend({
  baseUrl: 'http://localhost:8000',
  outputValidators: [
    (text) => (text.length > 0 ? { ok: true } : { ok: false, reason: 'empty answer', severity: 'hard' }),
  ],
  toolValidators: [
    ({ tool }) => (tool === 'exec' ? { ok: false, reason: 'exec not allowed in this lane' } : { ok: true }),
  ],
})
```

### Metrics

Every completed `run()` surfaces per-run token / cost / latency accounting:

- On `AgentResponse.usage`: cumulative `costUsd` (when pricing is known) plus `extras.metricsTotalTokens` / `metricsToolCalls` / `metricsTurns` / `metricsWallClockMs`.
- As a structured `run.warning` (code `agent.metrics`, exported as `AGENT_METRICS_WARNING_CODE`) when the run has an event sink, so dashboards and the `@skelm/metrics` collector can read per-run numbers from the event log without re-summing turns. The `message` is a JSON object `{ tokens, costUsd, toolCalls, turns, wallClockMs }`.

`@skelm/metrics` consumes the run event stream; wiring these `run.warning` metrics into a dedicated Prometheus series is a follow-up in that package — the numbers are already on the result and in the event log today.

Host roots such as `http://localhost:11434`, `/v1` bases such as `http://localhost:8000/v1`, nested bases such as `https://openrouter.ai/api/v1`, and exact URLs ending in `/chat/completions` are all accepted.

## Streaming

When a run has an event sink (the runner supplies `onPartial`, or `events` + `runId` + `stepId` on the `BackendContext`), agent-loop turns are issued with `stream: true` (SSE) and every assistant content delta is published as a `step.partial` event — one event per delta, not cumulative; the concatenation of all deltas equals the turn's final text. Tool-call turns stream too (the `tool_calls` fragments are assembled, then executed exactly as on the non-streaming path), and permission enforcement is unchanged. Without an event sink the backend issues plain non-streaming requests. If the upstream rejects `stream: true`, the turn is retried once non-streaming, so SSE-less servers keep working.

## Session lifecycle

Configure a `sessionStore` (`InMemorySessionStore`, `FileSessionStore`, or your own `SessionStore`) and `agent()` runs that supply a `sessionId` resume the saved conversation and save the updated history back on completion. On top of the store, the package exports lifecycle verbs that work with **any** `SessionStore` implementation:

| Verb | Shape | Behavior |
|---|---|---|
| `forkSession(store, sourceId, targetId)` | → `SerializedSession` | Copy (fork/clone) a session under a new id; the copies are independent. |
| `exportSession(store, id)` | → `SerializedSession` | Portable JSON snapshot of a session; throws if missing. |
| `importSession(store, id, json)` | → `SerializedSession` | Validate untrusted JSON (`assertSerializedSession`) and persist it. |
| `store.list()` / `store.delete(id)` | — | Enumerate / remove stored sessions. |
| `shouldCompact(...)` / `compact(...)` | — | Token/payload-budget compaction: collapse the history prefix into a summary `system` turn. |

## Replay events

With an event sink wired, a run is fully replayable from its event log. A dashboard can rely on:

- `step.partial` — one event per streamed content delta (`delta` is the chunk, not cumulative).
- `tool.call` / `tool.result` — emitted for **both** native built-in tool execution and MCP tool dispatch (`tool`, `arguments`, then `result: { content, isError? }` + `durationMs`).
- `tool.denied` + `permission.denied` — a blocked tool call (denylist, fs/network/exec policy, delegation) emits both; no `tool.call`/`tool.result` is emitted for the denied dispatch.

## Provider examples

```ts
// OpenRouter
createSkelmAgentBackend({
  id: 'agent',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  model: 'openai/gpt-5.2',
  headers: {
    'HTTP-Referer': 'https://skelm.dev',
    'X-OpenRouter-Title': 'skelm',
  },
})
```

```ts
// Ollama
createSkelmAgentBackend({
  id: 'agent',
  baseUrl: 'http://localhost:11434',
  model: 'qwen2.5-coder',
})
```

```ts
// vLLM / SGLang
createSkelmAgentBackend({
  id: 'agent',
  baseUrl: 'http://localhost:8000/v1',
  apiKey: 'unused',
  model: 'qwen35',
})
```

For `agent()` tool use, the selected model/provider must support OpenAI-style tool calls (`tools`, assistant `tool_calls`, and `role: "tool"` messages). Plain `infer()` usage only requires normal Chat Completions text responses.

## System prompt

Every `agent()` step gets a structured default system prompt — Identity, environment, tool-use discipline, available tools (built-ins + MCP), skills inventory, safety, tone, and coding-agent guidance — followed by your `agentDef` (AGENTS.md / SOUL.md) and `step.system` so user content lands last and carries recency weight. The builder lives in `@skelm/core/system-prompt`.

Override surface on each `agent()` step:

- `agentDef: './agents/foo'` — append AGENTS.md (and optional SOUL.md) to the prompt.
- `system: string | (ctx) => string` — append a free-form `# Instructions` block.
- `systemPromptMode: 'extend' | 'replace'` — `'replace'` drops the built-in default; default is `'extend'`.
- `systemPromptIncludeAgentDef: boolean` — when replacing, keep AGENTS.md/SOUL.md anyway (default `true`).

See [`docs/concepts/system-prompt.md`](https://github.com/scottgl9/skelm/blob/main/docs/concepts/system-prompt.md) for the full section list and per-backend behavior.

## Built-in tools

Every tool calls `TrustEnforcer` before its side effect. Denials emit `permission.denied` events and surface to the model as a `Permission denied: <reason>` tool result, so the model can recover or report.

| Tool | Permission gate | Behavior |
|---|---|---|
| `fs_read` | `fsRead` + `normalizePath` (rejects `../` traversal and absolute paths outside roots) | Read a text file |
| `fs_read_glob` | `fsRead` | List a directory with optional `*` pattern filter |
| `fs_write` | `fsWrite` | Write/overwrite a file; creates parent dirs |
| `fs_append` | `fsWrite` | Append to a file (creates if missing) |
| `read_file` | `fsRead` | Read a file or a 1-based line range; output carries line-number prefixes for precise edits |
| `write_file` | `fsWrite` | Create/overwrite a file (named alias of `fs_write`; prefer `edit_file` for in-place changes) |
| `edit_file` | `fsWrite` | In-place edit: unique find/replace (or `replaceAll`) **or** a 1-based line-range swap. Refuses without writing when the find target is missing or ambiguous |
| `http_fetch` | `canFetch(hostname)` (URL parsed first — non-http schemes rejected) | GET / POST / PUT / DELETE / PATCH; response body capped at 4 KiB |
| `ls` | `fsRead` | Directory listing |
| `get_secret` | `allowedSecrets` (resolved by the runner) | Returns a masked-availability sentinel — **never** the raw secret value |
| `load_skill` | `allowedSkills` via `canLoadSkill` | Returns the resolved skill's metadata |
| `exec` | `canExec(basename(command))` + `canRead(cwd)` if `cwd` provided | Run an allowed binary; **`spawn()` with `shell: false`** — argv array is passed directly, shell metacharacters are NOT expanded. `executableProfiles` expand into `allowedExecutables` at resolution time, so a profile-granted binary is allowed and a non-granted one denied |
| `memory_search` | `agentmemory` op `search` via `canUseAgentmemory` | Hybrid (BM25 + vector + graph) search over cross-session memory |
| `memory_save` | `agentmemory` op `save` | Persist an insight for later recall |
| `memory_recall` | `agentmemory` op `recall` | Recall recent / by-session memories |

Unknown tool names fall through to `ctx.mcpHost.invokeTool(name, args)` (gated by `canCallTool`), so MCP servers registered with the runner show up automatically.

### Run state, artifacts, and browser (contract tools)

Three further tool groups are **contract-defined**. They are advertised only when their handle/provider is wired onto the agent step; absent the handle they are not advertised and refuse if reached:

| Tool(s) | Gate | Status |
|---|---|---|
| `state_get` / `state_set` | Presence of a run-state handle (default-deny: no handle ⇒ denied). No new permission dimension. | Contract defined; **pending runtime wiring** — `BackendContext` does not yet expose a state handle, so today these tools report "not available". |
| `artifact_put` | Presence of an artifact sink. | Contract defined; **pending runtime wiring** on `BackendContext`. |
| `browser_navigate` / `browser_click` / `browser_type` / `browser_screenshot` / `browser_extract` | Requires a wired `BrowserProvider`; navigation routes through the **`network`** dimension (`canFetch(host)`), and `browser_screenshot` additionally requires an artifact sink. | **Contract only here — Playwright (or any driver) lands in a future `@skelm/browser-automation` package.** The browser posture reuses the existing `network` dimension plus an artifact sink rather than introducing a new core permission dimension. Without a provider the browser tools are never advertised. |

`builtinToolsForContext(ctx)` is the forward-compatible registration path: it returns `BUILTIN_TOOLS` plus the state/artifact/browser tools whose handles are present on the context. `BrowserProvider`, `StateHandle`, and `ArtifactHandle` are exported so `@skelm/browser-automation` and custom hosts can supply concrete handles.

### Notes on `exec`

- Argv is passed to `spawn()` as an array with `shell: false`. To run a shell pipeline, the caller must put `bash` (or similar) in `allowedExecutables` **and** pass `["-c", "<pipeline>"]` as args — granting that is a deliberate, visible policy choice.
- 64 KiB stdout / 64 KiB stderr caps. Output beyond is flagged `stdoutTruncated` / `stderrTruncated` in the JSON tool result.
- 30 s default timeout, clamped to `[1ms, 300_000ms]`. Honors the agent step's `BackendContext.signal` — the child is `SIGKILL`-ed on abort or timeout.
- Optional `cwd` arg is gated through `canRead` so an exec can't pivot the process into a directory outside the agent's read-allowlist.

## Security model

- **Default-deny is structural.** Every permission dimension defaults to `undefined`, which `resolvePermissions` treats as deny. Step-level grants are *intersected* with the project-default policy — if your config sets `networkEgress: 'deny'`, a step requesting `networkEgress: 'allow'` resolves to deny. The backend honors the *resolved* policy, not the step's raw request.
- **No undeclared exec.** Until you grant `allowedExecutables`, the `exec` tool refuses every binary the model names — even if `allowedTools: ['*']` is set. The same is true for `fs_read` / `fs_write` (gated by `fsRead`/`fsWrite`) and `http_fetch` (gated by `networkEgress`).
- **No URL-scheme abuse.** `http_fetch` parses the URL before checking permissions; `file://`, `gopher://`, etc. fail at the URL parser. Non-allowlisted hostnames (including unintended loopback) fail at `canFetch`.
- **Secrets stay masked.** `get_secret` confirms availability but returns a fixed sentinel; the raw value reaches the tool's host context (env vars passed to allowed executables) but never the model's transcript.
- **Audit by event.** Denials publish `permission.denied` (dimension-tagged) and successful exec / fetch / fs / skill / secret ops publish their respective events. The runner's audit writer is the durable record.

The CI guard `gateway-only-enforcement` enforces that `node:child_process` imports outside `packages/gateway/` carry a `// @subprocess-ok: <reason>` annotation. `@skelm/agent`'s import is annotated *"native exec tool gated by AgentPermissions.allowedExecutables"*.

## Example: positive grants

```ts
agent({
  id: 'fetch-and-write',
  backend: 'native-agent',
  prompt: 'Fetch https://example.com, save it as /tmp/cache/example.html, then summarize.',
  maxTurns: 6,
  permissions: {
    allowedTools: ['http_fetch', 'fs_write'],
    networkEgress: { allowHosts: ['example.com'] },
    fsWrite: ['/tmp/cache/'],
    fsRead: [],
    allowedExecutables: [],
    allowedSkills: [],
    allowedMcpServers: [],
  },
})
```

```ts
agent({
  id: 'run-curl',
  backend: 'native-agent',
  prompt: 'Call exec(command="curl", args=["-sS","https://example.com"]) and report the body.',
  maxTurns: 3,
  permissions: {
    allowedTools: ['exec'],
    allowedExecutables: ['curl'],
    networkEgress: 'allow',     // curl will do its own outbound; or use gateway egress proxy
    fsRead: [],
    fsWrite: [],
    allowedSkills: [],
    allowedMcpServers: [],
  },
})
```

Remember: both fixtures only work if the *project default* leaves those dimensions open enough to intersect with the grant. For a default-deny config, lift the relevant dimension in `defaults.permissions` (or use a permission profile) — see [skelm's permissions docs](https://github.com/scottgl9/skelm/tree/main/docs).

## License

MIT
