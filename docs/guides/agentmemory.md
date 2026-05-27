# agentmemory integration

skelm ships a first-class, **non-MCP** integration with [agentmemory](https://github.com/rohitg00/agentmemory) — a standalone memory microservice that records observations and serves cross-session recall. The `@skelm/agentmemory` package and supported backends consume it directly over the upstream REST API.

When enabled, every agent step on a supported backend opens a session, captures the user prompt (`user_prompt_submit`), recalls relevant memories before the first model call (prepended to the system prompt), records an observation per tool call (`@skelm/agent`) or per turn (other backends), and closes the session on exit.

A runnable walkthrough lives in `examples/agentmemory/` — it demonstrates the two-run recall pattern and how custom code calls the broadened ops.

**Disabled by default.** The integration is off until you opt in at *two* layers: the gateway config (`agentmemory.enabled: true`) and per-agent permissions (the default-deny `agentmemory` ops). With either omitted, the gateway hands the step no handle at all and every memory hook is a silent no-op — no sessions, no observations, no recall.

## Supported backends

- `@skelm/agent` — per-tool observe + smart-search recall
- `@skelm/codex`
- `@skelm/opencode`
- `@skelm/vercel-ai`
- `@skelm/pi`

## Enable the integration

Start the agentmemory server:

```sh
npx @agentmemory/agentmemory
```

Add the block to `skelm.config.ts`:

```ts
import { defineConfig } from '@skelm/core'

export default defineConfig({
  agentmemory: {
    enabled: true,
    url: 'http://localhost:3111',
    secretName: 'AGENTMEMORY_SECRET',
    timeoutMs: 3000,
  },
  defaults: {
    permissions: {
      agentmemory: {
        allowObserve: true,
        allowSearch: true,
        allowSession: true,
      },
    },
  },
})
```

Opt in per step:

```ts
agent({
  id: 'review',
  permissions: {
    agentmemory: { allowObserve: true, allowSearch: true, allowSession: true },
  },
})
```

## Permissions

The `agentmemory` dimension is **default-deny**, like every other [permission](/concepts/permissions). Omitting the field denies every operation:

| Operation | Granted by | Used for |
|-----------|------------|----------|
| `observe` | `allowObserve: true` | `POST /agentmemory/observe` — record tool use, turn outcomes, and the user prompt (`user_prompt_submit`) |
| `search`  | `allowSearch: true`  | `POST /agentmemory/smart-search` — recall context to prepend to system prompts |
| `session` | `allowSession: true` | `POST /agentmemory/session/{start,end}` — open / close per-step sessions |
| `context` | `allowContext: true` | `POST /agentmemory/context` — fetch token-budgeted blocks (used by custom code) |
| `save`    | `allowSave: true`    | `POST /agentmemory/remember` — explicitly persist an insight (custom code) |
| `recall`  | `allowRecall: true`  | `GET /agentmemory/memories` and `GET /agentmemory/sessions` — recent / by-session retrieval and the sessions list (custom code) |
| `graph`   | `allowGraph: true`   | `POST /agentmemory/graph/query` — traverse the knowledge graph over concepts, files, and patterns (custom code) |

The built-in backend loops only use `observe`, `search`, and `session`. The `context`, `save`, `recall`, and `graph` ops are for custom backend/step code (see below) and stay denied unless you grant them.

A shorthand `agentmemory: 'deny'` zeroes the dimension even when defaults granted it. Per-step permissions intersect with project defaults; nothing widens.

agentmemory is opt-in per agent. A step that grants **no** agentmemory op receives no handle at all — its memory hooks are a silent no-op (no calls, no events). A step that grants some ops gets a handle; calls to a non-granted op are non-fatal — they emit `permission.denied` events (visible via the gateway run-events stream) and the agent loop continues with that op disabled.

## Trust boundary

The gateway owns the agentmemory `fetch`. The bearer secret (when configured) resolves through the same `SecretResolver` used for every other secret. Runtime and backends never call the network directly — they invoke methods on a gateway-supplied `AgentmemoryHandle`, which gates each call through `TrustEnforcer.canUseAgentmemory()` and swallows transport errors (emitted as `agentmemory.error` events for observability, never thrown into the agent loop).

## Custom backend/step code

A custom [backend](/guides/writing-a-backend) receives the handle as `ctx.agentmemory` (present only when the integration is enabled and the step's policy grants at least one op). Beyond the automatic observe + recall loop, the handle exposes explicit operations for code that wants to drive memory directly. Each call is gated and never throws — a denied op returns an empty result and emits `permission.denied`.

```ts
async run(req, ctx) {
  const mem = ctx.agentmemory
  if (mem !== undefined) {
    // Explicitly persist an insight (needs allowSave).
    await mem.save({ title: 'Auth decision', content: 'We standardized on HS256.' })
    // Recall recent memories / list sessions (both need allowRecall).
    const recent = await mem.recall({ limit: 5 })
    const sessions = await mem.sessions({ limit: 10 })
    // Traverse the knowledge graph (needs allowGraph).
    const graph = await mem.graphQuery({ query: 'authentication' })
  }
  // ... your model call ...
}
```

Grant the matching ops in the step's permissions (e.g. `agentmemory: { allowSave: true, allowRecall: true, allowGraph: true }`); they are default-deny like everything else.

## Configuration reference

```ts
agentmemory?: {
  enabled?: boolean        // default false; omit the block to disable
  url?: string             // default 'http://localhost:3111'
  secretName?: string      // name of secret resolved by SecretResolver, sent as Bearer
  timeoutMs?: number       // per-request timeout, default 3000
}
```

## Hook wiring per backend

| Backend            | Session  | Recall                          | Observe                          |
|--------------------|----------|---------------------------------|----------------------------------|
| `@skelm/agent`     | start/end| `<memory>` block on system      | per tool call (`post_tool_use` / `post_tool_failure`) + final answer (`task_completed`) |
| `@skelm/codex`     | start/end| prepended to composeSystemPrompt| per turn (`task_completed`)      |
| `@skelm/opencode`  | start/end| prepended to system             | per turn (`task_completed`)      |
| `@skelm/vercel-ai` | start/end| prepended to system             | per turn (`task_completed`)      |
| `@skelm/pi`        | start/end| prepended to RPC prompt         | per turn (`task_completed`)      |

## Troubleshooting

- **No memory effect:** verify the gateway logs `agentmemory client wired` at start. The factory is undefined until `config.agentmemory.enabled === true`.
- **Calls denied:** check the step's `permissions.agentmemory` — omitting it denies every op. Look for `permission.denied` events in the run stream.
- **Server unreachable:** the handle swallows transport errors and emits `agentmemory.error` events. The agent step succeeds; only the memory effect is lost.
- **Authorization required:** set `secretName` to a name your gateway secret resolver knows; the value is sent as `Authorization: Bearer <value>`.
- **Recall returns nothing despite observations being recorded:** the automatic loop writes with `observe` (raw observations) and reads with `smart-search`, which only surfaces **compressed** memories. agentmemory compresses raw observations into searchable memories on a background sweep that needs an LLM provider key (`AGENTMEMORY_AUTO_COMPRESS` + e.g. `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` on the server). Without it, observed activity is captured but not recalled. Explicit `save()` (`/remember`) is searchable immediately, independent of compression.
