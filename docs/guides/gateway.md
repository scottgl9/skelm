# Gateway

The skelm gateway is the long-running process that hosts your workflows. It is the canonical trust boundary — every permission decision, secret resolution, audit entry, and approval prompt flows through it — and the home of every persistent concern (config, registries, agent process supervision, ACP sessions, scheduler, HTTP/SSE).

There is **one** entry point: the `skelm` CLI. The gateway runs as a subcommand:

```bash
skelm gateway install              # install + start as a systemd user service (recommended)
skelm gateway start                # start: delegates to systemd if installed, foreground otherwise
skelm gateway start --foreground   # force foreground mode even when systemd unit is installed
skelm gateway start --detach       # start detached (background process, no systemd)
skelm gateway status               # show running pid, url, and reachability
skelm gateway status --json
skelm gateway stop                 # stop the gateway (systemd-aware)
```

There is no separate `skelm-gateway` executable.

## Network egress proxy

The gateway hosts an embedded CONNECT proxy that enforces `networkEgress` permissions at the gateway level — not advisory, **actually enforced**. Every agent subprocess is spawned with proxy environment variables pointing to the local proxy, which checks each outbound connection against the step's resolved policy.

### Configuration

Enable and configure the proxy in `skelm.config.ts`:

```ts
export default defineConfig({
  server: {
    port: 14738,
    proxy: {
      enabled: true,        // default: true
      port: 14739,          // default: server.port + 1
    },
  },
})
```

### How it works

1. **Proxy startup**: The gateway starts a CONNECT proxy listener on `server.port + 1` (default 14739)
2. **Subprocess injection**: Every agent subprocess gets these environment variables:
   ```bash
   HTTP_PROXY=http://127.0.0.1:14739
   HTTPS_PROXY=http://127.0.0.1:14739
   SKELM_EGRESS_TOKEN=<runId>:<stepId>
   ```
3. **Token-based policy lookup**: The proxy reads `Proxy-Authorization: Bearer <token>` from CONNECT requests, looks up the token → policy mapping, and enforces the policy
4. **Default deny**: Unknown/missing tokens → all connections denied (safe default)

### Policy enforcement

The proxy enforces `networkEgress` policies:

- `networkEgress: 'deny'` → reject all connections
- `networkEgress: 'allow'` → forward everything
- `{ allowHosts: ['api.openai.com'] }` → forward only listed hostnames, reject all others

### Audit

Every decision emits an audit event:

```json
{
  "event": "network.egress",
  "runId": "<run-id>",
  "stepId": "<step-id>",
  "host": "api.openai.com",
  "decision": "allow|deny",
  "reason?": "not-in-allowlist"
}
```

### Token lifecycle

- **Registration**: Before each agent step, the gateway registers the token → policy mapping
- **Injection**: The token is passed to the subprocess via `SKELM_EGRESS_TOKEN` env var
- **Cleanup**: After the step completes, the token is unregistered (prevents stale lookups)

This handles concurrent steps from different pipelines each getting their own policy enforced correctly.

## Installing as a background service

For production and persistent use, install the gateway as a systemd user service:

```bash
skelm gateway install
```

This writes `~/.config/systemd/user/skelm-gateway.service`, runs `systemctl --user daemon-reload`, and starts the service immediately via `systemctl --user enable --now skelm-gateway`. The service is configured to restart on failure and starts automatically on login.

**User lingering** controls whether the service survives after you log out and starts automatically at boot. If lingering is not enabled, `skelm gateway install` will warn you:

```
warning: user lingering is not enabled. The gateway will stop when you log out
and will not start automatically at boot. To fix this:

  loginctl enable-linger <username>
```

To remove the service:

```bash
skelm gateway uninstall
```

This stops the running service, disables it, removes the unit file, and reloads systemd.

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

When started with signal handlers attached (the default when the gateway runs in the foreground):

| Signal | Action |
|--------|--------|
| `SIGTERM`, `SIGINT` | Graceful stop with default drain timeout. |
| `SIGHUP` | Reload config and registries; in-flight runs continue. |

## HTTP control surface

When started in foreground mode (`skelm gateway start` without the systemd unit installed, or with `--foreground`) the gateway also binds an HTTP server (`server.host` / `server.port` from `skelm.config.ts`, default `127.0.0.1:14738`). Auth defaults to loopback-only (`auth.mode: 'none'`); set `auth.mode: 'bearer'` and `SKELM_TOKEN` for remote use.

The gateway also starts an embedded **egress proxy** on `server.port + 1` (default `14739`). Every agent subprocess receives `HTTP_PROXY`, `HTTPS_PROXY`, and `SKELM_EGRESS_TOKEN` environment variables automatically, making `networkEgress` enforcement real rather than advisory. Set `server.proxy.enabled: false` to disable it, or `server.proxy.port` to use a custom port.

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

## Triggers

The gateway hosts a `TriggerCoordinator` that fires workflows on schedules, webhooks, polled changes, and queue messages. Pipelines declare their triggers inline (`pipeline({ triggers: [...] })`); long-running event sources (Telegram, Slack, custom queues) register as `triggerSources` in `skelm.config.ts`. See the dedicated [triggers guide](./triggers.md) and the [`telegram-bot` example](https://github.com/scottgl9/skelm/tree/main/examples/telegram-bot).

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
