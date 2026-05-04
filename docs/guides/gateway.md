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

## HTTP control surface

When started with `skelm gateway start --foreground` the gateway also binds an HTTP server (`server.host` / `server.port` from `skelm.config.ts`, default `127.0.0.1:4000`). Auth defaults to loopback-only (`auth.mode: 'none'`); set `auth.mode: 'bearer'` and `SKELM_TOKEN` for remote use.

Routes:

| Route | Method | Purpose |
|-------|--------|---------|
| `/health` | GET | Cheap probe — `{ status, pid, state, stateDir }`. |
| `/gateway/pause` | POST | Block new triggers; in-flight runs continue. |
| `/gateway/resume` | POST | Opposite of pause. |
| `/gateway/reload` | POST | Re-scan FS-backed registries (same as `SIGHUP`). |
| `/approvals` | GET | List pending approval requests. |
| `/runs/:runId/approve` | POST | Body: `{ stepId, approver?, reason? }`. |
| `/runs/:runId/deny` | POST | Same body shape. |
| `/sessions` | GET | List ACP sessions. |
| `/sessions/:id/resume` | POST | Resume a paused session. |
| `/sessions/:id` | DELETE | Terminate a session. |
| `/triggers` | GET | List registered triggers. |
| `/triggers/:id/fire` | POST | Manually fire one trigger. |

Plus the existing pre-gateway routes (`/pipelines`, `/runs`, `/runs/:id/stream`, etc).

## Persistence

| File | Owner | Notes |
|------|-------|-------|
| `<stateDir>/gateway.lock` | lifecycle | Single-writer lock, doubles as audit-writer claim. |
| `<stateDir>/gateway.json` | lifecycle | Discovery — pid, url, token, startedAt. |
| `<stateDir>/audit.jsonl` | audit | Hash-chained append-only log; `skelm audit verify` walks it. |
| `<stateDir>/secrets.json` | secrets | Mode 0600. Only when `secrets.driver: 'file'`. |
| `<stateDir>/approvals.json` | approval gate | JSON snapshot of the pending queue, written on every change. |
| `<stateDir>/acp-sessions.json` | ACP session manager | All resident-agent sessions; `reconcile()` re-reads at start. |
| `<stateDir>/runs.sqlite` | RunStore | SqliteRunStore by default; configurable via `storage.runs`. |

## Phase status

Phases 0–13 of the gateway-centric refactor are landed. Phase 13 closes the loop by binding the HTTP control surface to `skelm gateway start`, persisting the approval queue, and wiring the gateway-managed `RunStore` into trigger-dispatched runs.
