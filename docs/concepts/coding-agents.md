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

## Backend wiring (Phase 11)

Existing backends (`@skelm/opencode`, `@skelm/pi`) use a static `apiUrl` today. In Phase 11 they ask the gateway for the active resident handle by id and consume `handle.url`, so a crash-and-restart of `opencode serve` is invisible to the next step that runs.

For ephemeral agents, the same backend code can call `spawnEphemeral` instead of HTTPing — the choice is per-entry by `lifecycle`.

## Status

Phase 8 lands the supervisor. Existing backend factories continue to read static URLs until Phase 11 wires them through the gateway.
