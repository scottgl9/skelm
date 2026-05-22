# @skelm/agent

> First-party native agent backend for [skelm](https://github.com/scottgl9/skelm) — runs a multi-turn LLM loop against any OpenAI-compatible endpoint, with permissions enforced **in-process** by skelm's own `TrustEnforcer`.

[![npm](https://img.shields.io/npm/v/@skelm/agent)](https://www.npmjs.com/package/@skelm/agent)

Part of [skelm](https://github.com/scottgl9/skelm).

No dependency on Pi, Opencode, or ACP. The agent loop, the tool surface, and the permission gating all live in this package. Capabilities advertised to skelm:

| Capability | Value |
|---|---|
| `prompt` | `true` — drives `llm()` steps via single-shot inference |
| `run` | `true` — drives `agent()` steps with multi-turn tool use |
| `mcp` | `true` — unknown tool names fall through to `ctx.mcpHost.invokeTool` |
| `skills` | `true` — `load_skill` is gated by `allowedSkills` |
| `toolPermissions` | `'native'` — every tool calls `TrustEnforcer` before its side effect |
| `streaming` | `false` |

## Install

```bash
npm install @skelm/agent
```

You also need an OpenAI-compatible chat-completions endpoint. Anything that speaks `POST /v1/chat/completions` works: OpenAI, Anthropic via a proxy, [llama.cpp server](https://github.com/ggerganov/llama.cpp), [vllm](https://github.com/vllm-project/vllm), [Ollama](https://ollama.ai) with `/v1` enabled, etc.

## Quick start

```ts
// skelm.config.ts
import { defineConfig } from '@skelm/core'
import { createSkelmAgentBackend } from '@skelm/agent'

export default defineConfig({
  backends: { agent: 'native-agent', llm: 'native-agent' },
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
      // intentionally no permission grants — agent runs purely in conversation
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
  model?: string         // default model when the step doesn't specify one
  timeoutMs?: number     // LLM HTTP timeout (default 300_000)
})
```

The backend issues `POST {baseUrl}/v1/chat/completions`. If your provider exposes a different path (e.g. `/v1` already in `baseUrl`), pass the host root — the `/v1/chat/completions` suffix is appended.

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
| `http_fetch` | `canFetch(hostname)` (URL parsed first — non-http schemes rejected) | GET / POST / PUT / DELETE / PATCH; response body capped at 4 KiB |
| `ls` | `fsRead` | Directory listing |
| `get_secret` | `allowedSecrets` (resolved by the runner) | Returns a masked-availability sentinel — **never** the raw secret value |
| `load_skill` | `allowedSkills` via `canLoadSkill` | Returns the resolved skill's metadata |
| `exec` | `canExec(basename(command))` + `canRead(cwd)` if `cwd` provided | Run an allowed binary; **`spawn()` with `shell: false`** — argv array is passed directly, shell metacharacters are NOT expanded |

Unknown tool names fall through to `ctx.mcpHost.invokeTool(name, args)` (gated by `canCallTool`), so MCP servers registered with the runner show up automatically.

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
