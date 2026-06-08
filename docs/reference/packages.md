# Packages

skelm ships as a set of focused packages. Install the meta-package `skelm` for the common case — it re-exports `@skelm/core` and bundles the CLI. Reach for an individual `@skelm/*` package when you only need one slice (a backend, the integration SDK, metrics).

| Package | Purpose |
|---------|---------|
| `skelm` | Meta-package — install this, re-exports `@skelm/core` + CLI |
| `@skelm/core` | Runtime, types, builders, permission model, event bus |
| `@skelm/cli` | CLI commands — `run`, `schedule`, `gateway`, `audit` |
| `@skelm/gateway` | Long-running orchestrator: HTTP, scheduler, agent lifecycle |
| `@skelm/scheduler` | Cron, interval, and webhook triggers (poll, queue, file-watch, event-source live in `@skelm/gateway`) |
| `@skelm/integrations` | Typed connectors for GitHub, Slack, Telegram |
| `@skelm/integration-sdk` | Authoring SDK for building custom skelm integrations |
| `@skelm/pi` | Pi coding-agent backend |
| `@skelm/opencode` | Opencode coding-agent backend |
| `@skelm/codex` | OpenAI Codex backend via the official `@openai/codex-sdk` |
| `@skelm/vercel-ai` | Vercel AI SDK backend with streaming |
| `@skelm/agent` | First-party native agent backend with built-in tools |
| `@skelm/agentmemory` | Optional cross-session memory via the agentmemory server: typed REST client + gateway-wired handle |
| `@skelm/metrics` | Prometheus-format metrics |
| `@skelm/otel` | OpenTelemetry tracing |

For the full repository layout — including non-published directories (`examples`, `scripts/guards`, and `docs`) — see the **Repo shape** section of [`AGENTS.md`](https://github.com/scottgl9/skelm/blob/main/AGENTS.md).

## Workflow packages

Reusable workflows can also ship as regular npm dependencies. These are not new
skelm framework packages; they are user or vendor packages that declare
`skelm.workflowPackage` metadata in their own `package.json`. Hosts register
them from explicit installed package roots with `discoverWorkflowPackage()` and
`WorkflowRegistry.registerPackage()`.

See [Workflow Packages](../guides/workflow-packages.md) for the manifest shape,
asset convention, and registration flow.
