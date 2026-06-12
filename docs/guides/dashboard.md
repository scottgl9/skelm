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

## App shell and modules

The browser app is a small, dependency-free module shell:

- a left nav lists modules grouped under **Operate** and **Inspect**, a content
  area renders the active module, and the current module refreshes on a short
  interval (paused while a tab is hidden or an event stream is open, so the view
  does not churn);
- a single typed `gateway` proxy client wraps `fetch` against the same-origin
  `/api/*` proxy — every module reads through it and never touches a token.

| Module | Reads | Notes |
| ------ | ----- | ----- |
| Overview | `/v1/dashboard/overview`, `/v1/dashboard/runtime`, `/v1/dashboard/runs` | Health cards + recent runs |
| Workflows | `/pipelines`, `/pipelines/:id` | List + detail with a permissions summary; can execute or upload a workflow through the proxied gateway routes |
| Graph Viewer | `/v1/workflows/:id/graph` | Renders the [WorkflowGraph](../reference/workflow-graph.md) as a nested box diagram; control-flow containers nest their `children` and `codeOwned` nodes are marked |
| Runs | `/v1/dashboard/runs`, `/runs/:id`, `/runs/:id/events`, `/runs/:id/artifacts`, `/runs/:id/stream` | Run list + inspector with an event timeline and live streaming |
| Lineage & Tasks | `/v1/tasks`, `/v1/lineage/:runId` | Task list and a parent/child lineage tree |
| Packages | `/v1/packages`, `/v1/packages/:name` | Installed packages with manifest, integrity, and permissions summary |
| Integrations | `/v1/dashboard/runtime` | Read-only inventory of backends, MCP servers, and agents |
| Approvals | `/v1/dashboard/approvals` | Pending approvals |
| Schedules | `/v1/dashboard/schedules` | Trigger status |
| ACP Sessions | `/sessions`, `/v1/agentmemory/sessions` | Session summaries |
| Runtime | `/v1/dashboard/runtime` | Gateway runtime metadata |
| Audit | `/audit`, `/audit/verify` | Audit chain + entries |
| Metrics | `/metrics` | Prometheus metrics |

The graph viewer, run inspector timeline, lineage/tasks, package manager, and
integration admin modules are **read-only in this release**. Screenshots are
tracked separately. Mutation flows (a visual workflow builder/editor, package
install/remove, and an integration admin write surface) land in follow-up
slices. The only writes the current shell performs are workflow execution and
workflow upload from the Workflows module, both through the existing proxied
gateway routes.

Secret values are never rendered: the gateway payloads are already redacted and
the dashboard only surfaces permission dimension labels and profile names, never
hosts, paths, tool ids, or secret values.

By default the dashboard listens on `127.0.0.1:14740` and proxies to the
gateway at `127.0.0.1:14738`. The dashboard intentionally avoids `14739`,
which is the gateway egress proxy default.

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
- workflow imports from `.zip`, `.mts`, and `.ts` files through
  `/v1/workflows/register`
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
