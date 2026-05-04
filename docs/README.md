# skelm — documentation

Technical documentation for [skelm](../README.md), the TypeScript framework for secure, agentic, long-running workflows.

If you are reading this on GitHub, the rendered site lives at the project's documentation URL once published.

## Start here

- [Quickstart](./quickstart/index.md) — install, write a workflow, run it. About 5 minutes.

## Concepts

- [Workflows](./concepts/workflows.md) <!-- @planned --> — what a workflow is and how it composes
- [Steps](./concepts/steps.md) <!-- @planned --> — the step kinds and when to use each
- [Context](./concepts/context.md) <!-- @planned --> — the typed state that flows through a workflow
- [Agents](./concepts/agents.md) <!-- @planned --> — the `agent()` step and agent definitions
- [Skills](./concepts/skills.md) <!-- @planned --> — packaged capability units (`SKILL.md`)
- [Workspaces](./concepts/workspaces.md) <!-- @planned --> — per-agent filesystem roots
- [Permissions](./concepts/permissions.md) — default-deny security model
- [State](./concepts/state.md) <!-- @planned --> — KV state, journals, idempotency
- [Schedules](./concepts/schedules.md) <!-- @planned --> — scheduler-native execution
- [Runs](./concepts/runs.md) <!-- @planned --> — lifecycle, events, history
- [Observability](./concepts/observability.md) <!-- @planned --> — events, metrics, audit, OpenTelemetry

## Recipes

Complete, runnable workflows for the patterns customers ship most often:

- [Coding agent on chat](./recipes/coding-agent-on-chat.md) — long-running coding workflow reachable via webhook
- [Ticket to PR](./recipes/ticket-to-pr.md) — autonomous ticket-watcher that opens PRs
- [Email triage](./recipes/email-triage.md) — classify, summarize, journal
- [HTTP enrichment](./recipes/http-enrichment.md) — sync HTTP-triggered workflow with LLM enrichment

## Reference

- [API](./reference/api.md) <!-- @planned --> — `@skelm/core` public surface
- [CLI](./reference/cli.md) <!-- @planned --> — every command, flag, exit code
- [HTTP](./reference/http.md) <!-- @planned --> — endpoints, auth, errors, SSE
- [Configuration](./reference/config.md) <!-- @planned --> — `skelm.config.ts` schema
- [Providers](./backends/README.md) — ModelProvider and AgentProvider architecture
- [Agent definitions](./reference/agent-definitions.md) <!-- @planned --> — `AGENTS.md` / `SOUL.md` / `MEMORY.md` / `EXAMPLES.md`
- [Event schema](./reference/events.md) <!-- @planned -->
- [Audit categories](./reference/audit.md) <!-- @planned -->
- [Exit codes](./reference/exit-codes.md) <!-- @planned -->
- [Glossary](./reference/glossary.md) <!-- @planned -->

## Guides

- [Testing workflows](./guides/testing-workflows.md)
- [Writing a backend](./guides/writing-a-backend.md)
- [Writing a plugin](./guides/writing-a-plugin.md)
- [Authoring tips](./guides/authoring-tips.md)
- [Upgrading](./guides/upgrading.md)
- [Troubleshooting](./guides/troubleshooting.md)

## Deployment

- [systemd](./deployment/systemd.md) <!-- @planned --> — install the gateway as a user unit
- [Reverse proxy](./deployment/reverse-proxy.md) <!-- @planned --> — TLS and auth in front of the gateway
- [Postgres](./deployment/postgres.md) <!-- @planned M4 --> — production storage backend (M4)
- [Secrets](./deployment/secrets.md) <!-- @planned --> — env, file, vault drivers
- [Monitoring](./deployment/monitoring.md) <!-- @planned --> — Prometheus rules, OTel
- [Backup](./deployment/backup.md) <!-- @planned -->

## About

- [Tenets](./about/tenets.md) <!-- @planned --> — security, maintenance, robustness
- [Roadmap](./about/roadmap.md) <!-- @planned -->
- [Changelog](./about/changelog.md) <!-- @planned --> — generated
- [License](../LICENSE)

## Status

skelm is in early development. APIs are unstable until v1. Roadmap milestones (M1–M4) ship features in this order: core runtime + CLI → control flow + workspaces + state → gateway + audit + scheduler → integrations + agent routing + Postgres. See [the roadmap](./about/roadmap.md).
