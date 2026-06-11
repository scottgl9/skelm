# Coding agents

skelm treats coding agents (opencode, claude-code, pi, custom ACP runtimes) as first-class registry entries with one of two **lifecycles**:

| Lifecycle | Best for | Process model |
|-----------|----------|---------------|
| `resident` | Long-living serve-mode agents (`opencode serve`, daemonized ACP runtimes), shared across many runs and sessions. | Spawned once at gateway start (or first use). Health-checked, restarted on crash. URL handed to every consuming step. |
| `ephemeral` | Single-task agents that exit when the prompt is done (`claude-code`, one-shot Pi). | Spawned per workflow step. stdin / args carry the prompt. stdout / stderr / exit code form the step result. |

Both lifecycles are surfaced through the same `agents` registry and the same `agent()` step builder; the `lifecycle` field on the registry entry decides which strategy the supervisor uses.

## Declaring agents

```ts
defineConfig({
  registries: {
    agents: [
      {
        id: 'opencode-1',
        runtime: 'opencode',
        lifecycle: 'resident',
        command: 'opencode',
        args: ['serve', '--port', '${PORT}'],
        env: { OPENCODE_LOG: 'info' },
      },
      {
        id: 'claude-code',
        runtime: 'claude-code',
        lifecycle: 'ephemeral',
        command: 'claude',
        args: ['--print'],
      },
      {
        id: 'remote-pi',
        runtime: 'pi',
        lifecycle: 'resident',
        url: 'http://10.0.0.5:8088',
      },
    ],
  },
})
```

Notes:

- `${PORT}` in `args` is substituted with a free port the gateway picks at spawn time. The same port is also exported in `PORT=` for agents that read it from env.
- Resident entries with a `url` and no `command` are treated as already-running daemons — the supervisor only tracks the URL, never spawns or kills.
- Ephemeral entries with `lifecycle: 'ephemeral'` cannot be supplied a `url`.

## Resident lifecycle

```
config → spawn (port assigned) → spawn event → running → (crash) → backoff restart → ...
                                                  ↘ stop ↘ SIGTERM
```

- Crash policy: exponential backoff, default `[200, 500, 1000, 2500, 5000]` ms; gives up after `maxRestarts` (default 5).
- `restart(entry)` brings a `crashed` agent back online manually.
- In-flight request count (`inflight`) is exposed for introspection — it is not enforced. Consumers can apply quotas in their backend.

## Ephemeral lifecycle

`spawnEphemeral(entry, { stdin? | prompt? })` writes the input to the child's stdin, captures stdout / stderr, and resolves with `{ exitCode, stdout, stderr }`. The supervisor records the in-flight set so that `ephemeralRuns(id)` can introspect them and the optional `ephemeralConcurrency` cap can refuse new spawns.

## Backend wiring

The `@skelm/opencode` factory accepts an optional lazy `apiUrlProvider` resolver that the CLI / custom embeddings can populate from the gateway's coding-agent supervisor:

```ts
createOpencodeBackendFromConfig({
  apiKey: { secret: 'OPENCODE_API_KEY' },
  apiUrlProvider: () => gateway.managers.codingAgents.get('opencode-1')!.url,
})
```

The provider is awaited at backend-construction time, so the supervised URL
must be available when the registry is built. A static `apiUrl` remains
supported when no provider is supplied.

For ephemeral agents, custom backends can call `gateway.managers.codingAgents.spawnEphemeral(entry, { stdin })` directly inside the backend's `run()` instead of HTTPing — the choice is per-entry by `lifecycle`.

## Status

The gateway owns the coding-agent supervisor. Existing backend factories can still read static URLs, and gateway-managed backends can consume resident agent URLs through the manager.
