# Gateway HTTP reference

The gateway exposes a control plane and runs surface over HTTP. This page is
the human-readable index; the [OpenAPI spec](./openapi.yaml) is the
machine-readable source of truth.

## Auth

All routes require a bearer token unless explicitly noted. Configure tokens
via gateway config or environment. Unauthenticated requests get `401`.

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

| Method | Path                        | Description                          |
| ------ | --------------------------- | ------------------------------------ |
| GET    | `/pipelines`                | List registered pipelines            |
| GET    | `/pipelines/:id`            | Describe one pipeline                |
| POST   | `/pipelines/:id/run`        | Run a pipeline synchronously         |
| POST   | `/pipelines/:id/start`      | Start an async run; returns runId    |

## Runs

| Method | Path                          | Description                          |
| ------ | ----------------------------- | ------------------------------------ |
| GET    | `/runs/:runId`                | Get run record                       |
| GET    | `/runs/:runId/events`         | SSE/JSONL event stream for a run     |
| POST   | `/runs/:runId/resume`         | Resume a waiting run                 |
| POST   | `/runs/:runId/approve`        | Approve a paused approval gate       |
| POST   | `/runs/:runId/deny`           | Deny a paused approval gate          |

## Approvals

| Method | Path             | Description                          |
| ------ | ---------------- | ------------------------------------ |
| GET    | `/approvals`     | List pending approvals               |

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
