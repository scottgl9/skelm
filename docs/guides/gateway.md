# Gateway

The skelm gateway is the long-running process that hosts your workflows. It is the canonical trust boundary — every permission decision, secret resolution, audit entry, and approval prompt flows through it — and the home of every persistent concern (config, registries, agent process supervision, ACP sessions, scheduler, HTTP/SSE).

There is **one** entry point: the `skelm` CLI. The gateway runs as a subcommand:

```bash
skelm gateway start --foreground   # run in this process; Ctrl-C to stop
skelm gateway start --detach       # fork a foreground gateway (Phase 11)
skelm gateway status               # show running pid / url
skelm gateway status --json
```

There is no separate `skelm-gateway` executable.

## State files

By default the gateway writes its lockfile and discovery file under `~/.skelm`:

| File | Purpose |
|------|---------|
| `~/.skelm/gateway.lock` | Single-writer lockfile. A second gateway refuses to start if a live process holds it. Doubles as the audit-writer claim (Phase 5). |
| `~/.skelm/gateway.json` | Discovery: `{ pid, url, token, startedAt }`. Read by `skelm gateway status` and `skelm run --remote`. |

In a project, you can point the state dir at `.skelm/` instead by passing `--state-dir` (Phase 11).

## Lifecycle states

```
stopped → starting → running ⇄ paused → stopping → stopped
                          │
                          └─→ reload (config + registries re-read)
```

| State | Meaning |
|-------|---------|
| `stopped` | No process; lockfile released. |
| `starting` | Acquiring lockfile, writing discovery, attaching signals. |
| `running` | Accepting triggers and HTTP requests. |
| `paused` | New triggers and HTTP starts blocked; in-flight runs continue. |
| `stopping` | Draining in-flight runs (configurable timeout), releasing lock. |

## Signal handling

When started with signal handlers attached (the default for `skelm gateway start --foreground`):

| Signal | Action |
|--------|--------|
| `SIGTERM`, `SIGINT` | Graceful stop with default drain timeout. |
| `SIGHUP` | Reload config and registries; in-flight runs continue. |

## Phase status

Phase 2 of the gateway-centric refactor. The lifecycle shell, lockfile, discovery file, and the foreground `start` / `status` CLI verbs are landed. Subsequent phases add: registries (Phase 3), trust-boundary instances (Phase 4), audit + secrets (Phase 5), approvals (Phase 6), MCP supervision (Phase 7), coding-agent + ACP supervision (Phases 8–9), trigger wiring (Phase 10), and the remaining CLI verbs and `--remote` polish (Phase 11).
