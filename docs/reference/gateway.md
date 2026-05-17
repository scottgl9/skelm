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
skelm gateway install              # install + start as a systemd user service (recommended)
skelm gateway start                # start in the foreground; Ctrl-C to stop
skelm gateway start --detach       # start as a detached background process
skelm gateway status               # pid, URL, reachability, state
skelm gateway stop                 # stop the running gateway (systemd-aware)
skelm gateway reload               # SIGHUP — hot-reloads skelm.config.ts
```

### Background service (recommended)

`skelm gateway install` is the recommended way to run the gateway in production:

1. Writes `~/.config/systemd/user/skelm-gateway.service`
2. Runs `systemctl --user daemon-reload`
3. Runs `systemctl --user enable --now skelm-gateway` to start immediately and enable on login
4. Warns if user lingering is not enabled

If the service cannot be started because user lingering is not enabled (no D-Bus session at boot), you will see:

```
warning: user lingering is not enabled. The gateway will stop when you log out
and will not start automatically at boot. To fix this:

  loginctl enable-linger <username>
```

`skelm gateway stop` delegates to `systemctl --user stop` when the unit is installed, keeping systemd's state in sync and preventing auto-restart. It falls back to SIGTERM if systemctl fails.

### Foreground start

`skelm gateway start` is now context-aware:

- **If the systemd unit is installed** — delegates to `systemctl --user start` and returns immediately, leaving the gateway running as a managed background service. Equivalent to having run `skelm gateway install` once and then just using `start` going forward.
- **If the systemd unit is not installed** — runs in the foreground (blocks your terminal) and prints a tip:

  ```
  tip: run `skelm gateway install` to install the gateway as a persistent background service.
  ```

Pass `--foreground` to force foreground mode even when the unit is installed.

Pass `--detach` to spawn an unmanaged background process and return immediately (useful when systemd is not available):

```bash
skelm gateway start --detach
# skelm gateway started (detached)
#   pid: 12345
#   url: http://127.0.0.1:14738
```

### Status

`skelm gateway status` checks whether the process is alive and, when a URL is known, probes it over HTTP:

```
gateway: running
  pid: 12345
  startedAt: 2025-01-01T00:00:00.000Z
  url: http://127.0.0.1:14738
  reachable: yes
```

The `reachable` field is `yes` when the HTTP endpoint responds to a probe, `no (port may not be bound yet)` when the process is alive but not yet accepting connections, and omitted when no URL is known.

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
| POST | `/v1/batch/runs` | Fan-out async starts (default cap 50 items, configurable); per-item outcome |
| POST | `/v1/batch/cancel` | Cancel multiple runs by id; per-id outcome |
| GET | `/v1/config` | Sanitized projection of the current `SkelmConfig` |
| PATCH | `/v1/config` | Hot-update whitelist (currently `server.maxConcurrentRuns` only) |

Default port: `14738`, default host: `127.0.0.1`. Configure via `server.port` and `server.host` in `skelm.config.ts`.

### Workflow registration

`POST /v1/workflows/register` accepts an explicit `id`, a `source` of the form `{ "type": "path", "path": "..." }`, and optional `description` / `version`. Paths are resolved via `realpath` and must sit inside the gateway's `projectRoot` or one of the directories listed in `GatewayOptions.allowedRegistrationDirs`; everything else is rejected with `400`. Registered workflows are written one-JSON-per-id under `${stateDir}/registered-workflows/` and replayed at boot, so they survive restarts. Raw TypeScript source (`source.type === "code"`) is **not** accepted — a future revision will define a sandbox before adding it.

`POST /v1/workflows/register` and `PUT /v1/workflows/:id` also accept a `multipart/form-data` request containing a `.zip` archive of the workflow source. Fields:

- `archive` — the `.zip` file (required)
- `id` — workflow id (required on POST when no path param; PUT takes it from the URL)
- `entry` — relative path inside the archive that points at the pipeline file (optional; the gateway auto-detects a single root-level `*.workflow.ts` or `*.pipeline.ts` when omitted)
- `description`, `version` — optional metadata

The archive is validated by magic bytes, capped at `GatewayOptions.workflows.maxArchiveBytes` (default 5 MiB, applied to both the compressed and total uncompressed sizes), and extracted into `${stateDir}/uploaded-workflows/${encodeURIComponent(id)}/`. Archive entries with `..`, absolute paths, or non-allowlisted extensions (anything outside `.ts`, `.js`, `.mjs`, `.cjs`, `.json`, `.md`, `.txt`, `.yaml`, `.yml`) are rejected. `POST` refuses to register if the extraction dir already has contents — use `PUT` to replace. `DELETE /v1/workflows/:id` also wipes the extraction dir for archive-sourced workflows.

### Batch operations

`POST /v1/batch/runs` takes `{ items: [{ id, input? }, ...] }` and fans out to the same async-start path that `POST /pipelines/:id/start` uses. A per-item error never fails the whole batch — each item reports `{ id, accepted, runId?, error?, description? }` independently. `description` is a stable short category for debugging (`started`, `workflow-not-found`, `invalid-input`, `start-failed`); `error` carries the raw message. The maximum batch size defaults to 50 items and is configurable via `GatewayOptions.batch.maxItemsPerRequest`. `POST /v1/batch/cancel` takes `{ runIds: [...] }` and reports per-id `cancelled: true|false`.

### Runtime config

`GET /v1/config` returns a sanitized projection of the active `SkelmConfig` — secret driver paths are redacted, no bearer tokens are echoed. `PATCH /v1/config` accepts a flat dot-keyed body and only honors keys in the hot-update whitelist (currently `server.maxConcurrentRuns`); anything else returns `400`. The whitelist is intentionally narrow: only hot-reloadable, side-effect-bounded, non-security-relevant fields belong here. Auth, trust roots, secret-driver paths, and storage settings require a gateway restart so changes survive a reconcile and audit. Updates go through `Gateway.reload()` so existing infrastructure picks them up.

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
skelm gateway install     # writes unit, daemon-reload, enable --now
                          # warns if loginctl linger is not enabled
skelm gateway stop        # systemd-aware stop
skelm gateway uninstall   # stop, disable, remove unit, daemon-reload
```
