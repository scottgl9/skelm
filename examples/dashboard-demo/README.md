# dashboard-demo

A minimal single-file dashboard that consumes the gateway's
`/v1/dashboard/*` endpoints. No build step, no dependencies — just open the
HTML in a browser.

## Run

```bash
# 1. Start a gateway
skelm gateway start

# 2. Open the page
open examples/dashboard-demo/index.html
```

Enter the gateway URL (default `http://127.0.0.1:14738`) and, if the gateway
is configured with `auth.mode: 'bearer'`, your bearer token. Both are kept in
`localStorage`. The page polls every five seconds — matching the server-side
cache TTL on `/overview`.

## What it shows

- **Gateway** — status, version, uptime
- **Runs** — totals, last-24h, average duration, status breakdown
- **Approvals** — pending count and oldest age
- **Schedules** — total/inflight/with errors
- **Workflows table** — per-workflow success rate and last run
- **Recent errors** — last failures with messages
- **Triggers** — registered triggers with fire counts

## Customizing

The page is intentionally one self-contained HTML file (~250 lines, no
framework). Fork it as a starting point for your own dashboard. The API
reference is at [`docs/reference/http.md`](../../docs/reference/http.md) and
[`docs/reference/openapi.yaml`](../../docs/reference/openapi.yaml).
