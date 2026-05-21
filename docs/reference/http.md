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

The `:id` path segment is the workflow-registry id — by default this is the file path relative to the project root (e.g. `workflows%2Fhello.workflow.ts`, URL-encoded). Workflow files referenced from `invoke()` steps inside the pipeline are resolved separately by the gateway's `pipelineRegistry`, which matches first on registry id and falls back to scanning all registered workflows for one whose `pipeline.id` equals the requested value.

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

## Schedules

| Method | Path                  | Description                          |
| ------ | --------------------- | ------------------------------------ |
| GET    | `/schedules`          | List schedules                       |
| POST   | `/schedules`          | Add a schedule                       |
| DELETE | `/schedules/:id`      | Remove a schedule                    |

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
| GET    | `/v1/dashboard/schedules`     | Trigger status: kind, workflowId, fired count, inflight, lastFiredAt, lastError            |
| GET    | `/v1/dashboard/approvals`     | Pending approvals with `ageMs`; reports `pendingCount` and `oldestPendingAgeMs`            |

Example:

```
curl -H "Authorization: Bearer $SKELM_TOKEN" \
  "http://127.0.0.1:14738/v1/dashboard/analytics?metric=runs-per-hour&resolution=hour&dateFrom=1715600000000&dateTo=1715686400000"
```

A minimal reference dashboard that consumes these endpoints lives in
[`examples/dashboard-demo`](https://github.com/scottgl9/skelm/tree/main/examples/dashboard-demo).

## OpenAI compatibility (optional surface)

| Method | Path                       | Description                          |
| ------ | -------------------------- | ------------------------------------ |
| POST   | `/v1/chat/completions`     | OpenAI-compatible chat surface       |
| POST   | `/v1/responses`            | OpenAI-compatible responses API      |

## See also

- [OpenAPI spec](./openapi.md) — full request/response schemas (rendered, with YAML download)
- [`docs/reference/cli.md`](./cli.md) — the `skelm` CLI uses these endpoints
