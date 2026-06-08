# dashboard-demo

A minimal single-file dashboard that consumes the gateway's
`/v1/dashboard/*` endpoints. No build step, no dependencies — just open the
HTML in a browser.

## Run

```bash
# 1. Start a gateway
skelm gateway start --foreground

# 2. Open the page
open examples/dashboard-demo/index.html
```

Enter the gateway URL (default `http://127.0.0.1:14738`) and, if the gateway
is configured with `auth.mode: 'bearer'`, your bearer token. Both are kept in
`localStorage`. The page polls every five seconds — matching the server-side
cache TTL on `/overview`.

## What it shows

Read-only summary cards from `/v1/dashboard/*`:

- **Gateway** — status, version, uptime
- **Runs** — totals, last-24h, average duration, status breakdown
- **Approvals** — pending count and oldest age
- **Schedules** — total/inflight/with errors
- **Workflows table** — per-workflow success rate and last run
- **Recent errors** — last failures with messages
- **Triggers** — registered triggers with fire counts
- **Workflow health API** — `/v1/workflows/health` is available for dashboards
  that need readiness, active runs, recent failures, and trigger state in one
  workflow-keyed response.

Control panels backed by the REST surface:

- **Workflows** — `GET /v1/workflows` for the list; register from a host
  path (`POST /v1/workflows/register`) or upload a `.zip` archive
  (multipart `POST` or `PUT /v1/workflows/:id` to replace). Delete buttons
  call `DELETE /v1/workflows/:id`.
- **Batch run** — POST a JSON `items` array to `/v1/batch/runs` and render
  each per-item outcome, including the new stable `description` category.
  The configured cap is fetched from `/v1/config` and displayed above the
  form.
- **Gateway config** — pretty-prints the sanitized `/v1/config` projection
  and offers a one-field form to PATCH `server.maxConcurrentRuns`.

## Customizing

The page is intentionally one self-contained HTML file, no build step and
no dependencies. Fork it as a starting point for your own dashboard. The
API reference is at [`docs/reference/http.md`](../../docs/reference/http.md)
and [`docs/reference/openapi.yaml`](../../docs/reference/openapi.yaml).
