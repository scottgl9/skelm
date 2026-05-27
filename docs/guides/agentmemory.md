# agentmemory integration

skelm ships a first-class, **non-MCP** integration with [agentmemory](https://github.com/rohitg00/agentmemory) — a standalone memory microservice that records observations and serves cross-session recall. The `@skelm/agentmemory` package and supported backends consume it directly over the upstream REST API.

When enabled, every agent step on a supported backend opens a session, recalls relevant memories before the first model call (prepended to the system prompt), records an observation per tool call (`@skelm/agent`) or per turn (other backends), and closes the session on exit.

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

The `agentmemory` dimension is **default-deny**, like every other [permission](/concepts/permissions). Omitting the field denies all four operations:

| Operation | Granted by | Used for |
|-----------|------------|----------|
| `observe` | `allowObserve: true` | `POST /agentmemory/observe` — record tool use and turn outcomes |
| `search`  | `allowSearch: true`  | `POST /agentmemory/smart-search` — recall context to prepend to system prompts |
| `session` | `allowSession: true` | `POST /agentmemory/session/{start,end}` — open / close per-step sessions |
| `context` | `allowContext: true` | `POST /agentmemory/context` — fetch token-budgeted blocks (used by custom code) |

A shorthand `agentmemory: 'deny'` zeroes the dimension even when defaults granted it. Per-step permissions intersect with project defaults; nothing widens.

Denials are non-fatal: they emit `permission.denied` events (visible via the gateway run-events stream) and the agent loop continues with that op disabled.

## Trust boundary

The gateway owns the agentmemory `fetch`. The bearer secret (when configured) resolves through the same `SecretResolver` used for every other secret. Runtime and backends never call the network directly — they invoke methods on a gateway-supplied `AgentmemoryHandle`, which gates each call through `TrustEnforcer.canUseAgentmemory()` and swallows transport errors (emitted as `agentmemory.error` events for observability, never thrown into the agent loop).

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
| `@skelm/agent`     | start/end| `<memory>` block on system      | per tool call (`post_tool_use` / `post_tool_failure`) |
| `@skelm/codex`     | start/end| prepended to composeSystemPrompt| per turn (`task_completed`)      |
| `@skelm/opencode`  | start/end| prepended to system             | per turn (`task_completed`)      |
| `@skelm/vercel-ai` | start/end| prepended to system             | per turn (`task_completed`)      |
| `@skelm/pi`        | start/end| prepended to RPC prompt         | per turn (`task_completed`)      |

## Troubleshooting

- **No memory effect:** verify the gateway logs `agentmemory client wired` at start. The factory is undefined until `config.agentmemory.enabled === true`.
- **Calls denied:** check the step's `permissions.agentmemory` — omitting it denies every op. Look for `permission.denied` events in the run stream.
- **Server unreachable:** the handle swallows transport errors and emits `agentmemory.error` events. The agent step succeeds; only the memory effect is lost.
- **Authorization required:** set `secretName` to a name your gateway secret resolver knows; the value is sent as `Authorization: Bearer <value>`.
