# MCP servers

skelm hosts MCP servers as a first-class registry concern: declare them in `skelm.config.ts` and the gateway supervises their lifetime. Per-run consumers receive a shared handle (URL or stdio process) instead of spawning a child themselves.

## Declaring servers

```ts
defineConfig({
  registries: {
    mcpServers: [
      { id: 'fs',     transport: 'stdio', command: 'mcp-server-fs', args: ['/workspace'] },
      { id: 'github', transport: 'http',  url: 'http://localhost:9100' },
      { id: 'slack',  transport: 'sse',   url: 'http://localhost:9200/sse' },
    ],
  },
})
```

Reload via `SIGHUP` (or `gateway.reload(nextConfig)`) re-applies the declaration set; added entries spawn, removed entries terminate, modified entries restart.

## Supervisor behavior

| Transport | Supervised? | Notes |
|-----------|-------------|-------|
| `stdio` | yes | Spawned as a child of the gateway with `command` + `args` + merged `env`. SIGTERM on stop. |
| `http`, `sse` | no | URL handle only — the gateway tracks the entry but does not manage the process. |

Crash handling for stdio:

- `exit` event flips the handle to `crashed` and records `code=...` / `signal=...` as `lastError`.
- The supervisor schedules a restart using a backoff schedule (default `[200ms, 500ms, 1s, 2.5s, 5s]`).
- After `maxRestarts` (default 5) consecutive failures, the supervisor stops trying. Operators must call `restart()` explicitly to bring it back.

## Consuming a handle in a step

```ts
agent({
  id: 'reviewer',
  backend: 'claude',
  mcpServers: ['fs', 'github'],   // ids resolved against the gateway registry
})
```

The runtime asks the gateway for the active `McpServerHandle` for each id when the step starts. If the handle is in `stopped` or `crashed`, the step fails fast and an audit entry is written.

## Status

The `McpServerManager` is part of the gateway manager set. Agent steps resolve `mcpServers: [...]` against `gateway.managers.mcp`, and custom embeddings can also drive the manager directly.
