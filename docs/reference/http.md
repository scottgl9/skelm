# Gateway HTTP reference

The gateway exposes a control plane and runs surface over HTTP. This page is
the human-readable index; the [OpenAPI spec](./openapi.yaml) is the
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

## OpenAI compatibility (optional surface)

| Method | Path                       | Description                          |
| ------ | -------------------------- | ------------------------------------ |
| POST   | `/v1/chat/completions`     | OpenAI-compatible chat surface       |
| POST   | `/v1/responses`            | OpenAI-compatible responses API      |

## See also

- [`docs/reference/openapi.yaml`](./openapi.yaml) — full request/response schemas
- [`docs/reference/cli.md`](./cli.md) — the `skelm` CLI uses these endpoints
