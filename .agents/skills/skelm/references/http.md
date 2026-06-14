# Gateway HTTP reference

The gateway exposes a control plane and runs surface over HTTP. This page is
the human-readable index; the [OpenAPI spec](./openapi.md) is the
machine-readable source of truth.

## Auth

By default the gateway listens on `127.0.0.1:14738` with `auth.mode: 'none'`.
Set `server.auth = { mode: 'bearer' }` in `skelm.config.ts` to require a
bearer token; unauthenticated requests then get `401`. Tokens are read from
the environment.

## Health & metrics

| Method | Path        | Description                          |
| ------ | ----------- | ------------------------------------ |
| GET    | `/health`   | Liveness probe; returns `{status}`   |
| GET    | `/metrics`  | Prometheus-format metrics            |

## Gateway lifecycle

| Method | Path                | Description                         |
| ------ | ------------------- | ----------------------------------- |
| POST   | `/gateway/pause`    | Stop accepting new runs             |
| POST   | `/gateway/resume`   | Resume accepting new runs           |
| POST   | `/gateway/reload`   | Re-read pipelines and config        |

## Pipelines

| Method | Path                        | Description                                      |
| ------ | --------------------------- | ------------------------------------------------ |
| GET    | `/pipelines`                | List registered pipelines                        |
| GET    | `/pipelines/:id`            | Describe one pipeline (graph + JSON schemas)     |
| POST   | `/pipelines/:id/run`        | Run synchronously; returns final state           |
| POST   | `/pipelines/:id/start`      | Start an async run; returns runId                |

Both `/run` and `/start` accept an optional `Idempotency-Key` header; the same
key for the same pipeline returns the cached run.

The `:id` path segment is the workflow-registry id — by default this is the file path relative to the project root (e.g. `workflows%2Fhello.workflow.mts`, URL-encoded). Workflow files referenced from `invoke()` steps inside the pipeline are resolved separately by the gateway's `pipelineRegistry`, which matches first on registry id and falls back to scanning all registered workflows for one whose `pipeline.id` equals the requested value.

## Runs

| Method | Path                          | Description                                      |
| ------ | ----------------------------- | ------------------------------------------------ |
| DELETE | `/runs/:runId`                | Cancel an in-flight run                          |
| POST   | `/runs/:runId/resume`         | Resume a `wait()` step; body `{ output? }`        |
| GET    | `/runs/:runId/events`         | Return persisted events (`{ runId, events }`); accepts `?since` and `?limit` |

## Approvals

| Method | Path                          | Description                                      |
| ------ | ----------------------------- | ------------------------------------------------ |
| GET    | `/approvals`                  | List pending approvals                           |
| POST   | `/runs/:runId/approve`        | Approve a paused approval gate; body `{ stepId, approver?, reason? }` |
| POST   | `/runs/:runId/deny`           | Deny a paused approval gate; body `{ stepId, approver?, reason? }` |

## Triggers

| Method | Path                       | Description                          |
| ------ | -------------------------- | ------------------------------------ |
| GET    | `/triggers`                | List registered triggers             |
| POST   | `/triggers/:id/fire`       | Manually fire a trigger              |

## Projects

| Method | Path                              | Description                                                  |
| ------ | --------------------------------- | ----------------------------------------------------------- |
| POST   | `/v1/projects/activate`           | Activate a project directory; body `{ dir }`                |
| GET    | `/v1/active`                      | Running view: persistent workflows, triggers, in-flight runs |
| POST   | `/v1/workflows/:id/deactivate`    | Stop a workflow; body `{ cancelInflight? }`                 |
| POST   | `/v1/chat/:sourceId/submit`       | Inject a chat-UI line (transport `tui` or `web`); body `{ sessionId, text, from? }` → `{ runId }` |

`activate` is how `skelm run <dir>` lands a triggered/persistent project on a
running gateway. The gateway imports the directory's `skelm.config.*` **in its
own process** (the trigger-source drivers and backend instances are live
objects that cannot cross HTTP), registers its queue drivers, absorbs its
backend instances, registers its workflow files, arms their declared triggers,
and merges its `unrestrictedGrants` + `agentmemory` into the running config. In
addition, the project's `defaults.permissions`, `defaults.permissionProfiles`,
and `backends.{agent,infer}` are pinned **per workflow id** — they apply when
the gateway dispatches that workflow's runs (persistent turn, queue/cron, or
HTTP `POST /pipelines/:id/run`) and do not bind another activated project's
workflows on the same gateway. See [Permissions › Per-workflow project
ceilings](../../../docs/concepts/permissions.md#per-workflow-project-ceilings).

**Security (path-gated).** A `dir` outside the gateway's trusted `projectRoot` /
`allowedRegistrationDirs` is refused **wholesale and before its config is
imported** — nothing is registered, no grant is escalated, no backend absorbed
(`trusted: false` in the response). Importing runs arbitrary top-level code as
the gateway user, so an untrusted project stays inert. Every grant that goes
live is recorded per turn through the single audit writer as `permission.bypassed`.

Re-activating an already-active directory is an idempotent refresh
(`refresh: true`). A project whose config uses a chat-UI source
(`createRemoteTriggerSource`, transport `tui` or `web`) is activated the same
way; the client (`skelm run` for `tui`, a browser for `web`) drives it through
`POST /v1/chat/:sourceId/submit` — the call returns the turn's `runId`, and the
client tails `/runs/:runId/stream` for partials and the final reply — so the
gateway itself stays headless and can run as a daemon.

`GET /v1/active` is the running view behind `skelm list`: it groups trigger
registrations by workflow, reports persistent-workflow session counts, and lists
in-flight runs. `POST /v1/workflows/:id/deactivate` is `skelm stop <id>` — it
unregisters every trigger for the workflow (stopping its queue driver) and drops
the registration so a reload will not re-arm it; persisted sessions are kept so a
re-activation resumes the conversation. Pass `{ cancelInflight: true }` to also
cancel the workflow's running turns. This is distinct from `skelm gateway stop`
(stops the whole process) and `DELETE /schedules/:id` (removes one trigger).

## Schedules

| Method | Path                  | Description                          |
| ------ | --------------------- | ------------------------------------ |
| GET    | `/schedules`          | List schedules                       |
| POST   | `/schedules`          | Add a schedule                       |
| DELETE | `/schedules/:id`      | Remove a schedule                    |

Schedule responses include `fired`, `inflight`, `queued`, `runningCount`,
`dropped`, `lastFiredAt`, `nextFireAt`, `lastOutcome`,
`lastOverlapDecision`, `lastError`, and `lastErrorAt` when applicable.
Webhook credentials such as `secret` and MS Graph `clientState` are redacted.

## Sessions

| Method | Path                          | Description                          |
| ------ | ----------------------------- | ------------------------------------ |
| GET    | `/sessions`                   | List ACP sessions                    |
| GET    | `/sessions/:id`               | Get one session                      |
| POST   | `/sessions/:id/resume`        | Resume a session                     |
| POST   | `/sessions/prune`             | Prune expired/old sessions           |
| DELETE | `/sessions/:id`               | Drop a session                       |

## Debug

| Method | Path                                | Description                       |
| ------ | ----------------------------------- | --------------------------------- |
| GET    | `/debug/breakpoints`                | List active breakpoints           |
| POST   | `/debug/breakpoints`                | Add a breakpoint                  |
| DELETE | `/debug/breakpoints/:stepId`        | Remove a breakpoint               |
| GET    | `/debug/runs`                       | List runs paused at breakpoints   |
| POST   | `/debug/runs/:runId/release`        | Release a paused run              |

## Dashboard (`/v1/dashboard/*`)

Read-only aggregations composed from the run store, registries, trigger
coordinator, and approval gate. Same bearer auth as the rest of the control
surface. Responses for `/overview` and `/analytics` are cached in-memory with
a five-second TTL.

| Method | Path                          | Description                                                                                |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/v1/dashboard/overview`      | Snapshot: gateway, workflows, runs (status counts, last-24h, avg duration), schedules, approvals, errors |
| GET    | `/v1/dashboard/workflows`     | Per-workflow stats: totalRuns, lastRunAt, lastStatus, successRate                          |
| GET    | `/v1/dashboard/runs`          | Filtered run list. Query: `workflowId`, `status`, `dateFrom`, `dateTo` (epoch ms), `limit` |
| GET    | `/v1/dashboard/analytics`     | Time-bucketed series. Query: `metric=runs-per-hour\|success-rate\|avg-duration`, `resolution=hour\|day\|week`, `dateFrom`, `dateTo`, `workflowId?` |
| GET    | `/v1/dashboard/errors`        | Recent failed runs + groupings by pipeline + message. Query: `limit`                       |
| GET    | `/v1/dashboard/schedules`     | Trigger status: kind, workflowId, fired count, inflight, queue/running counts, next/last fire metadata, lastError |
| GET    | `/v1/dashboard/approvals`     | Pending approvals with `ageMs`; reports `pendingCount` and `oldestPendingAgeMs`            |
| GET    | `/v1/dashboard/runtime`       | Gateway runtime metadata: auth mode, metrics status, backends, agents, MCP servers, ACP sessions, advisory backends |

Example:

```
curl -H "Authorization: Bearer $SKELM_TOKEN" \
  "http://127.0.0.1:14738/v1/dashboard/analytics?metric=runs-per-hour&resolution=hour&dateFrom=1715600000000&dateTo=1715686400000"
```

Use `skelm dashboard init` and `skelm dashboard start` for the maintained local
dashboard app.

## Memory Inspection

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/runs/:runId/artifacts` | List workspace-backed artifacts for a run |
| GET    | `/runs/:runId/artifacts/:artifactId` | Download artifact bytes |
| GET    | `/v1/state/:namespace` | List workflow KV state entries. Query: `prefix`, `limit` |
| GET    | `/v1/state/:namespace/:key` | Read one workflow KV state value |
| GET    | `/v1/agentmemory/status` | Agentmemory client status |
| GET    | `/v1/agentmemory/sessions` | Agentmemory sessions. Query: `limit` |

## Workflow health (`/v1/workflows/health`)

Read-only workflow health endpoints compose registry entries, best-effort
`describePipeline` loading, run-store summaries, active runs, and trigger state.
They use the same bearer auth middleware as the rest of the gateway control
surface.

| Method | Path                         | Description |
| ------ | ---------------------------- | ----------- |
| GET    | `/v1/workflows/health`       | Health for all workflows. Query: `recentFailuresLimit=0..100` |
| GET    | `/v1/workflows/:id/health`   | Health for one workflow id; URL-encode ids containing `/` |

The collection route is failure-isolating: a workflow that fails to import is
reported with `readiness.status: "broken"` while other workflows remain in the
response. Health run counts are bounded; `runs.truncated: true` means the
reported counts and refs are partial. If no workflow loader is configured,
`readiness.checks.loadable` is `null` and `ready` is `false`.

## OpenAI compatibility (optional surface)

| Method | Path                       | Description                          |
| ------ | -------------------------- | ------------------------------------ |
| POST   | `/v1/chat/completions`     | OpenAI-compatible chat surface       |
| POST   | `/v1/responses`            | OpenAI-compatible responses API      |

## See also

- [OpenAPI spec](./openapi.md) — full request/response schemas (rendered, with YAML download)
- [`docs/reference/cli.md`](./cli.md) — the `skelm` CLI uses these endpoints
