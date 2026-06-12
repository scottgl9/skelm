# Dashboard

`skelm dashboard` scaffolds and runs a local operations dashboard for a live
gateway. The dashboard is a maintained skelm feature: it uses the gateway HTTP
surface, supports bearer-auth gateways through a local server-side proxy, and
does not store gateway tokens in the browser.

## Start

```sh
skelm dashboard init
skelm gateway start --foreground
skelm dashboard start
```

The scaffold defaults to `./dashboard` and uses `.mts` TypeScript source:

- `dashboard.config.mts`
- `src/server.mts`
- `src/public/app.mts`
- `src/public/styles.css`

The generated project has no local dependencies. `skelm dashboard start`
imports `src/server.mts` directly and serves `src/public/app.mts` as `/app.js`
after stripping TypeScript types with Node's built-in loader.

## Gateway connection

Set the gateway URL and bearer token with flags or environment variables:

```sh
skelm dashboard start \
  --gateway-url http://127.0.0.1:14738 \
  --token "$SKELM_TOKEN"
```

Equivalent environment variables:

- `SKELM_DASHBOARD_GATEWAY_URL`
- `SKELM_DASHBOARD_TOKEN`
- `SKELM_DASHBOARD_HOST`
- `SKELM_DASHBOARD_PORT`

## What the UI Uses

The dashboard reads and mutates the real gateway:

- health, config, runtime metadata, backends, agents, MCP servers
- workflow listing and workflow execution
- run history, run details, run events, event streams, artifacts
- audit entries and audit-chain verification
- approval approve/reject flows
- schedules and manual fire
- ACP sessions
- agentmemory status/session summaries
- Prometheus metrics when metrics are enabled

Optional gateway features degrade in place. For example, metrics show the
gateway error when metrics are disabled, and agentmemory shows disabled status
when no agentmemory client is configured.

## Design Notes

The dashboard architecture is intentionally small:

- a local Node server serves static assets and proxies `/api/*` to the gateway
- bearer auth is injected by the server from config/env/flags
- the browser app only calls same-origin `/api/*`
- new gateway API surface is limited to dashboard inspection gaps:
  runtime metadata, state reads, artifact reads, and agentmemory status

ACP advisory permission mode is surfaced through runtime metadata and audit
events so operators can see when a backend is running with weaker permission
guarantees.
