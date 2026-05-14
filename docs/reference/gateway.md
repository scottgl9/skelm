# Gateway Reference

## What the gateway is

The gateway is a long-running process that is the **trust boundary** for all skelm security infrastructure. It owns:

- **Permission resolution** — intersects project defaults, profiles, and step-level policies into a `ResolvedPolicy`.
- **Permission enforcement** — `TrustEnforcer` is called before any privileged action (tool call, exec, MCP attach, network request, fs access).
- **Secret resolution** — resolves secret references before passing values to backends.
- **Audit log** — writes a tamper-evident, hash-chained audit trail for every privileged action.
- **Approval gating** — queues actions for human approval; the runtime calls `runtime.approvalGate.request(...)` at the start of every agent step whose policy declares `approval`.
- **Trigger dispatch** — receives cron, webhook, interval, and queue triggers; starts runs accordingly.
- **Registry management** — watches workflow, skill, and MCP server directories; hot-reloads on change.
- **ACP session persistence** — survives gateway restarts; sessions are re-attached on startup.

**Never write enforcement logic in pipeline or step code.** Pipelines are the user layer; the gateway is the trust layer.

## Starting the gateway

```bash
skelm gateway start               # foreground; SIGTERM/Ctrl-C drains and exits
skelm gateway status              # pid, URL, state
skelm gateway stop                # SIGTERM a running gateway
skelm gateway reload              # SIGHUP — hot-reloads skelm.config.ts
skelm gateway install --systemd   # install ~/.config/systemd/user/skelm-gateway.service
```

`skelm gateway start` always runs in the foreground; pass `--detach` and the CLI will tell you to spawn it via systemd or a shell wrapper instead. For long-running deployments, install the systemd unit.

The gateway is required for:
- Agent steps (permission enforcement, backend lifecycle)
- Trigger-based execution (cron, webhook, etc.)
- Approval gating
- History and audit storage via SQLite

`skelm run` works without the gateway for simple pipelines (no agent steps, in-memory run store).

## HTTP surface

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check |
| GET | `/registry/workflows` | List discovered workflows |
| POST | `/runs` | Start a run (sync or async) |
| GET | `/runs/:id` | Fetch run state |
| GET | `/runs/:id/events` | SSE event stream |
| POST | `/runs/:id/cancel` | Cancel a run |
| POST | `/runs/:id/resume` | Resume a `wait()` step |
| POST | `/approvals/:id/approve` | Approve a gated action |
| POST | `/approvals/:id/deny` | Deny a gated action |
| GET | `/audit` | Query audit log |
| GET | `/v1/dashboard/*` | Aggregated read-only views (overview, runs, analytics, errors, schedules, approvals) |
| GET | `/v1/workflows` | List explicitly registered workflows |
| POST | `/v1/workflows/validate` | Compile-check a workflow source file (no persistence) |
| POST | `/v1/workflows/register` | Register a workflow source path; persisted under `${stateDir}/registered-workflows/` |
| PUT | `/v1/workflows/:id` | Replace a registered workflow |
| DELETE | `/v1/workflows/:id` | Unregister a workflow (existing runs preserved) |
| POST | `/v1/batch/runs` | Fan-out async starts (cap 50 items); per-item outcome |
| POST | `/v1/batch/cancel` | Cancel multiple runs by id; per-id outcome |
| GET | `/v1/config` | Sanitized projection of the current `SkelmConfig` |
| PATCH | `/v1/config` | Hot-update whitelist (currently `server.maxConcurrentRuns` only) |

Default port: `14738`, default host: `127.0.0.1`. Configure via `server.port` and `server.host` in `skelm.config.ts`.

### Workflow registration

`POST /v1/workflows/register` accepts an explicit `id`, a `source` of the form `{ "type": "path", "path": "..." }`, and optional `description` / `version`. Paths are resolved via `realpath` and must sit inside the gateway's `projectRoot` or one of the directories listed in `GatewayOptions.allowedRegistrationDirs`; everything else is rejected with `400`. Registered workflows are written one-JSON-per-id under `${stateDir}/registered-workflows/` and replayed at boot, so they survive restarts. Raw TypeScript source (`source.type === "code"`) is **not** accepted — a future revision will define a sandbox before adding it.

### Batch operations

`POST /v1/batch/runs` takes `{ items: [{ id, input? }, ...] }` (max 50 items) and fans out to the same async-start path that `POST /pipelines/:id/start` uses. A per-item error never fails the whole batch — each item reports `{ id, accepted, runId?, error? }` independently. `POST /v1/batch/cancel` takes `{ runIds: [...] }` and reports per-id `cancelled: true|false`.

### Runtime config

`GET /v1/config` returns a sanitized projection of the active `SkelmConfig` — secret driver paths are redacted, no bearer tokens are echoed. `PATCH /v1/config` accepts a flat dot-keyed body and only honors keys in the hot-update whitelist (currently `server.maxConcurrentRuns`); anything else returns `400`. Updates go through `Gateway.reload()` so existing infrastructure picks them up.

## Network egress proxy

The gateway hosts an embedded CONNECT proxy (default port `server.port + 1` = 14739) that enforces `networkEgress` permissions. See the [Gateway guide](../guides/gateway.md#network-egress-proxy) for details.

Configure in `skelm.config.ts`:

```ts
server: {
  port: 14738,
  proxy: {
    enabled: true,     // default: true
    port: 14739,       // default: server.port + 1
  },
}
```

Agent subprocesses receive these environment variables:

```bash
HTTP_PROXY=http://127.0.0.1:14739
HTTPS_PROXY=http://127.0.0.1:14739
SKELM_EGRESS_TOKEN=<runId>:<stepId>
```

## Run events (SSE)

Connect to `GET /runs/:id/events` for a server-sent event stream. Events include:

- `run.started`, `run.completed`, `run.failed`, `run.cancelled`
- `step.started`, `step.completed`, `step.failed`, `step.skipped`
- `permission.denied` — emitted when enforcement blocks an action
- `tool.called`, `tool.result`

## Audit log

The gateway writes every privileged action to a hash-chained SQLite audit log. Query via:

```bash
skelm audit query --run <runId>
skelm audit query --action permission.denied --since 2025-01-01T00:00:00Z
```

## systemd integration

```bash
skelm gateway install --systemd    # writes ~/.config/systemd/user/skelm-gateway.service
systemctl --user enable skelm-gateway
systemctl --user start  skelm-gateway
```
