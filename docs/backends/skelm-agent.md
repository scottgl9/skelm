# skelm agent backend (`@skelm/agent`)

The **first-party native agent backend**. Runs a multi-turn LLM loop against
any OpenAI-compatible chat-completions endpoint, with permissions enforced
**in-process** by skelm's own `TrustEnforcer`.

No dependency on Pi, Opencode, or ACP — the agent loop, the tool surface, and
the permission gating all live inside this package. Powers both `infer()`
(single-shot inference) and `agent()` (multi-turn tool use).

## Install

```bash
pnpm add @skelm/agent
```

You also need an OpenAI-compatible chat-completions endpoint. Anything that
speaks the Chat Completions shape works: OpenAI, OpenRouter, Anthropic via a proxy,
[llama.cpp server](https://github.com/ggerganov/llama.cpp),
[vLLM](https://github.com/vllm-project/vllm),
[SGLang](https://github.com/sgl-project/sglang),
[Ollama](https://ollama.ai) with `/v1`, etc.

## Quickstart

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

Like the Vercel AI SDK backend, the CLI does not construct this backend from
a string-keyed `backends:` entry — pass a configured instance through
`instances:`.

## Options

| Option       | Type     | Default          | Description                                                              |
|--------------|----------|------------------|--------------------------------------------------------------------------|
| `id`         | `string` | `'agent'`        | Backend id used in `agent({ backend })` and `instances:`.                |
| `label`      | `string` | —                | Diagnostic label.                                                        |
| `baseUrl`    | `string` | **required**     | OpenAI-compatible host root or `/v1` base. Nested bases such as `https://openrouter.ai/api/v1` are supported. |
| `apiKey`     | `string` | —                | Sent as `Authorization: Bearer <key>` when present.                      |
| `headers`    | `Record<string,string>` | —     | Extra LLM request headers, e.g. OpenRouter `HTTP-Referer` and `X-OpenRouter-Title`. |
| `model`      | `string` | —                | Default model when the step doesn't specify one.                         |
| `timeoutMs`  | `number` | `300_000`        | LLM HTTP timeout in ms.                                                  |
| `sessionStore` | `SessionStore` | —          | Persist `run()` conversations across turns. See **Session persistence** below. |
| `onPromptAssembled` | `(info) => void` | —    | Debug hook invoked once per `run()` with the assembled system prompt text and the advertised tool names. Inspection only. |
| `budget`     | `AgentBudget` | —           | Cumulative harness safety limits for each `run()` loop. See **Budgets, validators, and metrics** below. |
| `outputValidators` | `OutputValidator[]` | — | Pure checks run on the final assistant text. See below. |
| `toolValidators` | `ToolValidator[]` | —     | Pure checks run before each tool dispatch. See below. |

`baseUrl` may be `http://localhost:11434`, `http://localhost:8000/v1`,
`https://openrouter.ai/api/v1`, or an exact URL ending in
`/chat/completions`.

### Streaming

When a run has an event sink (the runner supplies `onPartial`, or
`events` + `runId` + `stepId` on the `BackendContext`), agent-loop turns are
issued with `stream: true` (Server-Sent Events) and each assistant content
delta is published as a **`step.partial`** event — one event per delta, not
cumulative; the concatenation of all deltas equals the turn's final text.
Tool-call turns stream too: `tool_calls` fragments are assembled from the
deltas and executed exactly as on the non-streaming path, and permission
enforcement is unchanged — streaming changes how text arrives, not what is
enforced. Without an event sink (e.g. calling `run()` directly, or `infer()`
single-shot steps) the backend issues plain non-streaming requests,
bit-for-bit identical to the previous behavior. If the upstream rejects
`stream: true`, the turn is retried once on the non-streaming path, so
SSE-less servers keep working (their replies just produce no deltas).

### Budgets, validators, and metrics

These are **agent-harness** safety controls scoped to the `run()` loop. They
are *not* permission dimensions and *not* skelm's core durable HITL /
oversight primitives — they never widen anything, they only observe and (where
configured) abort a run. Every dimension is unset by default, so the loop's
behavior is unbounded and unchanged unless you opt in. Enforcement is
deterministic: typed errors plus existing `run.warning` events, never a silent
change.

**Budgets** (`budget: AgentBudget`) set cumulative ceilings across *all* turns
of one run:

| Field | Limits |
|-------|--------|
| `tokenBudget` | cumulative input + output tokens from each turn's `Usage` — distinct from the per-call `maxTokens` output cap and from `maxTurns` |
| `maxCostUsd` | cumulative estimated USD cost |
| `maxToolCalls` | total tool-call dispatches |
| `maxWallClockMs` | wall-clock elapsed since loop start |

When a ceiling is crossed the loop emits a `run.warning`
(`code: 'agent.budget.<dimension>'`) and then throws `AgentBudgetExceededError`
carrying `{ dimension, observed, limit }`. The check runs after each turn's
usage is folded in and after each tool-call increment.

Cost is derived from the model registry entry's `ModelCost` (USD per 1K
input/output tokens) when routing through a `registry`; in single-endpoint mode
there is no pricing, so cost falls back to any upstream-reported
`Usage.costUsd`, or 0 when neither is known (a priceless run never trips the
cost budget).

**Validators** are pure (sync or async) functions — no LLM calls inside the
harness. Each returns `{ ok: true }` or `{ ok: false, reason, severity? }`. A
soft failure (default) records a `run.warning`
(`code: 'agent.validator.<stage>'`) and the run continues; a hard failure
(`severity: 'hard'`) throws `AgentValidationError` (`{ stage, reason }`).

- `outputValidators` run once on the final assistant text:
  `(text, ctx) => ValidationResult`, with `ctx.stopReason` and parsed
  `ctx.structured` (when an `outputSchema` was requested).
- `toolValidators` run before each tool dispatch, *after* the `TrustEnforcer`
  permission gate, as an additional harness check:
  `({ tool, args }) => ValidationResult`. A hard failure aborts before the tool
  runs.

Validators are distinct from `outputSchema` validation: the runtime still
validates the step result against any declared `outputSchema` and surfaces
`SchemaValidationError` on mismatch. Validators add harness-level checks on top.

**Metrics.** Every completed run surfaces token / cost / latency accounting on
`AgentResponse.usage` — cumulative `costUsd` (when pricing is known) plus
`extras.metricsTotalTokens` / `metricsToolCalls` / `metricsTurns` /
`metricsWallClockMs` — and, when the run has an event sink, as a structured
`run.warning` (`code: 'agent.metrics'`, exported as
`AGENT_METRICS_WARNING_CODE`) whose `message` is JSON
`{ tokens, costUsd, toolCalls, turns, wallClockMs }`. `@skelm/metrics`
consumes the run event stream today; mapping these metrics into a dedicated
Prometheus series is a follow-up in that package.

### Session persistence

By default each `agent()` run is stateless. Configure a `sessionStore`
(`InMemorySessionStore`, `FileSessionStore`, or your own `SessionStore`) to
make runs resumable: the backend then advertises
`capabilities.sessionLifecycle: true`, and an `agent()` step that supplies a
`sessionId` resumes the prior conversation — the saved user/assistant/tool
turns are seeded ahead of the new prompt, and the full updated history is saved
back on completion. The system prompt is rebuilt fresh every run (current date,
tools, skills), so a persisted system turn is never replayed. Runs without a
`sessionId`, or with no `sessionStore` configured, stay stateless and persist
nothing. (Multimodal image content is flattened to its text in the persisted
history and is not re-sent on resume.)

#### Lifecycle verbs

On top of the store, `@skelm/agent` exports lifecycle verbs that work with
**any** `SessionStore` implementation:

- `forkSession(store, sourceId, targetId)` — copy (fork/clone) a session under
  a new id. The copies are independent; throws `BackendSessionError` when the
  source is missing.
- `exportSession(store, id)` — returns the portable `SerializedSession`
  snapshot; throws when missing.
- `importSession(store, id, json)` — validates untrusted JSON via
  `assertSerializedSession` (version, message roles/content) before
  persisting; nothing is saved on rejection.
- `store.list()` / `store.delete(id)` — enumerate / remove stored sessions.
- `shouldCompact(session, opts)` / `compact(messages, opts)` — the
  compact/summarize path: when the token or payload budget is exceeded,
  collapse the history prefix into a single summary `system` turn and keep
  the recent tail verbatim.

### Replay events

With an event sink wired (the runner supplies `events` + `runId` + `stepId`),
a run is fully replayable from its event log. A dashboard can rely on:

| Event | Contract |
|---|---|
| `step.partial` | One event per streamed content delta. `delta` is the new chunk, **not** cumulative; concatenating all deltas yields the turn's final text. |
| `tool.call` | Emitted before every tool execution — native built-ins **and** MCP dispatch — with `tool` and parsed `arguments`. |
| `tool.result` | Emitted after execution with `result: { content, isError? }` and `durationMs`. |
| `tool.denied` + `permission.denied` | A blocked tool call (denylist, fs/network/exec policy, delegation) emits both; no `tool.call` / `tool.result` is emitted for the denied dispatch. |

## Provider examples

OpenRouter:

```ts
export default defineConfig({
  backends: {
    agent: 'skelm-agent',
    'skelm-agent': {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: { secret: 'OPENROUTER_API_KEY' },
      model: 'openai/gpt-5.2',
      headers: {
        'HTTP-Referer': 'https://skelm.dev',
        'X-OpenRouter-Title': 'skelm',
      },
    },
  },
})
```

Ollama:

```ts
createSkelmAgentBackend({
  id: 'agent',
  baseUrl: 'http://localhost:11434',
  model: 'qwen2.5-coder',
})
```

vLLM / SGLang:

```ts
createSkelmAgentBackend({
  id: 'agent',
  baseUrl: 'http://localhost:8000/v1',
  apiKey: 'unused',
  model: 'qwen35',
})
```

For `agent()` tool use, the selected model/provider must support OpenAI-style
tool calls (`tools`, assistant `tool_calls`, and `role: "tool"` messages).

## Capabilities

| Flag                | Value      | Notes                                                                       |
|---------------------|------------|-----------------------------------------------------------------------------|
| `prompt`            | `true`     | Drives `infer()` steps via single-shot inference.                             |
| `run`               | `true`     | Drives `agent()` steps with multi-turn tool use.                            |
| `mcp`               | `true`     | Unknown tool names fall through to `ctx.mcpHost.invokeTool` (gated by `canCallTool`). |
| `skills`            | `true`     | `load_skill` returns metadata for skills allowed by `allowedSkills`.        |
| `toolPermissions`   | `'native'` | Every built-in tool calls `TrustEnforcer` before its side effect.           |
| `streaming`         | `true`     | Agent-loop turns stream over SSE and emit `step.partial` per delta when an event sink is present — see **Streaming** above. |
| `sessionLifecycle`  | `false`\*  | `true` when a `sessionStore` is configured; an `agent()` step that supplies `sessionId` then resumes the saved conversation. Default `false` (stateless). |

## Built-in tools

Every tool calls `TrustEnforcer` before its side effect. Denials emit
`permission.denied` events and surface to the model as a
`Permission denied: <reason>` tool result, so the model can recover or report.

| Tool            | Permission gate                                                                                   | Behavior                                                                                              |
|-----------------|---------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| `fs_read`       | `fsRead` + `normalizePath` (rejects `../` traversal and absolute paths outside roots)             | Read a text file.                                                                                     |
| `fs_read_glob`  | `fsRead`                                                                                          | List a directory with optional `*` pattern filter.                                                    |
| `fs_write`      | `fsWrite`                                                                                         | Write / overwrite a file; creates parent dirs.                                                        |
| `fs_append`     | `fsWrite`                                                                                         | Append to a file (creates if missing).                                                                |
| `read_file`     | `fsRead`                                                                                          | Read a file or a 1-based line range; output is line-number-prefixed for precise edits.               |
| `write_file`    | `fsWrite`                                                                                         | Create / overwrite a file (named alias of `fs_write`; prefer `edit_file` for in-place changes).      |
| `edit_file`     | `fsWrite`                                                                                         | In-place edit — unique find/replace (or `replaceAll`) **or** a 1-based line-range swap. Refuses without writing on a missing / ambiguous find. |
| `http_fetch`    | `canFetch(hostname)` (URL parsed first — non-http schemes rejected)                               | GET / POST / PUT / DELETE / PATCH; response body capped at 4 KiB.                                     |
| `ls`            | `fsRead`                                                                                          | Directory listing.                                                                                    |
| `get_secret`    | `allowedSecrets` (resolved by the runner)                                                         | Returns a masked-availability sentinel — **never** the raw secret value.                              |
| `load_skill`    | `allowedSkills` via `canLoadSkill`                                                                | Returns the resolved skill's metadata.                                                                |
| `exec`          | `canExec(basename(command))` + `canRead(cwd)` if `cwd` is supplied                                | Run an allowed binary; `spawn()` with `shell: false` — argv array is passed directly, no shell expansion. `executableProfiles` expand into `allowedExecutables` at resolution time. |
| `memory_search` | `agentmemory` op `search` via `canUseAgentmemory`                                                 | Hybrid (BM25 + vector + graph) search over cross-session memory.                                      |
| `memory_save`   | `agentmemory` op `save`                                                                           | Persist an insight for later recall.                                                                  |
| `memory_recall` | `agentmemory` op `recall`                                                                         | Recall recent / by-session memories.                                                                  |

Unknown tool names fall through to `ctx.mcpHost.invokeTool(name, args)`
(gated by `canCallTool`), so MCP servers registered with the runner show up
automatically.

### Contract tools: run state, artifacts, browser

Three further tool groups are **contract-defined**: they are advertised only
when their handle/provider is wired onto the agent step (via
`builtinToolsForContext(ctx)`), and absent the handle they are not advertised
and refuse if reached.

| Tool(s) | Gate | Status |
|---|---|---|
| `state_get` / `state_set` | Presence of a run-state handle (default-deny: no handle ⇒ denied). No new permission dimension. | Contract defined; **pending runtime wiring** — `BackendContext` does not yet expose a state handle, so today these tools report "not available". |
| `artifact_put` | Presence of an artifact sink. | Contract defined; **pending runtime wiring** on `BackendContext`. |
| `browser_navigate` / `browser_click` / `browser_type` / `browser_screenshot` / `browser_extract` | Requires a wired `BrowserProvider`; navigation routes through the **`network`** dimension (`canFetch(host)`), and `browser_screenshot` additionally requires an artifact sink. | **Contract only here — Playwright (or any driver) lands in a future `@skelm/browser-automation` package.** Hybrid placement: the typed contract and its permission posture live in `@skelm/agent`; the heavy driver dependency is deferred to the browser package. The posture reuses the existing `network` dimension plus an artifact sink rather than adding a new core permission dimension. Without a provider the browser tools are never advertised. |

`BrowserProvider`, `StateHandle`, and `ArtifactHandle` are exported from
`@skelm/agent` so `@skelm/browser-automation` and custom hosts can supply
concrete handles.

### Notes on `exec`

- Argv is passed to `spawn()` as an array with `shell: false`. To run a shell
  pipeline, put `bash` (or similar) in `allowedExecutables` **and** pass
  `["-c", "<pipeline>"]` as args — granting that is a deliberate, visible
  policy choice.
- 64 KiB stdout / 64 KiB stderr caps. Output beyond is flagged
  `stdoutTruncated` / `stderrTruncated` in the JSON tool result.
- 30 s default timeout, clamped to `[1 ms, 300_000 ms]`. Honors the agent
  step's `BackendContext.signal` — the child is `SIGKILL`-ed on abort or
  timeout.
- Optional `cwd` arg is gated through `canRead` so an exec can't pivot the
  process into a directory outside the agent's read-allowlist.

## Permission mapping

| skelm policy field   | Behavior in `@skelm/agent`                                                                                  |
|----------------------|-------------------------------------------------------------------------------------------------------------|
| `allowedTools`       | Filters the advertised tool set per turn. Undefined → all denied.                                           |
| `deniedTools`        | Removes tools from the result even if `allowedTools` would permit.                                          |
| `allowedExecutables` | Gates `exec` per-binary (basename match).                                                                   |
| `allowedMcpServers`  | Server ids the agent may attach. Unknown tool names fall through to `ctx.mcpHost.invokeTool` only when the resolved server is permitted. |
| `allowedSkills`      | `load_skill` only resolves ids in this set.                                                                 |
| `allowedSecrets`     | `get_secret` only confirms availability for names in this set; the raw value is never returned to the model. |
| `networkEgress`      | Gates `http_fetch` per-host **and** `browser_navigate` (a browser navigation is network egress). The LLM HTTP call to `baseUrl` is **not** gated by this — see Caveats. |
| `fsRead` / `fsWrite` | Path roots for read / write tools (`fs_*`, `read_file`, `write_file`, `edit_file`); enforced via `normalizePath`. |
| `agentmemory`        | Per-op gate (`search` / `save` / `recall` / …) for the `memory_*` tools via `canUseAgentmemory`; each op defaults to deny. |

## Security model

- **Default-deny is structural.** Every permission dimension defaults to
  `undefined`, which `resolvePermissions` treats as deny. Step-level grants
  are *intersected* with the project-default policy — if your config sets
  `networkEgress: 'deny'`, a step requesting `networkEgress: 'allow'`
  resolves to deny. The backend honors the *resolved* policy.
- **No undeclared exec.** Until you grant `allowedExecutables`, the `exec`
  tool refuses every binary the model names — even if `allowedTools: ['*']`
  is set. The same is true for `fs_read` / `fs_write` and `http_fetch`.
- **No URL-scheme abuse.** `http_fetch` parses the URL before checking
  permissions; `file://`, `gopher://`, etc. fail at the URL parser.
  Non-allowlisted hostnames (including unintended loopback) fail at
  `canFetch`.
- **Secrets stay masked.** `get_secret` confirms availability but returns a
  fixed sentinel; the raw value reaches the tool's host context (env vars
  passed to allowed executables) but never the model's transcript.
- **Audit by event.** Denials publish `permission.denied` (dimension-tagged);
  successful exec / fetch / fs / skill / secret ops publish their respective
  events. The runner's audit writer is the durable record.

The CI guard `gateway-only-enforcement` enforces that `node:child_process`
imports outside `packages/gateway/` carry a
`// @subprocess-ok: <reason>` annotation. `@skelm/agent`'s import is
annotated *"native exec tool gated by AgentPermissions.allowedExecutables"*.

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

Both grants only take effect if the *project default* leaves the same
dimensions open enough to intersect with the step-level request. For a
default-deny config, lift the relevant dimension in `defaults.permissions`
(or use a permission profile).

## Caveats and non-goals

- **`networkEgress` does not gate the LLM's HTTP call.** It controls
  `http_fetch` and per-tool network access. The backend itself reaches
  `baseUrl` directly.
- **Endpoint shape is OpenAI-compatible chat completions only.** Other API
  shapes are out of scope; use the Vercel AI SDK backend for Anthropic /
  Google / etc.

## See also

- [Backends overview](./README.md)
- [Permissions reference](../reference/permissions.md)
- [`@skelm/agent` README](https://github.com/scottgl9/skelm/blob/main/packages/agent/README.md)
- Source: [`packages/agent`](https://github.com/scottgl9/skelm/tree/main/packages/agent)
