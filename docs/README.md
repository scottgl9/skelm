# skelm — documentation

Technical documentation for [skelm](../README.md), the TypeScript framework for secure, agentic, long-running workflows.

If you are reading this on GitHub, the rendered site lives at the project's documentation URL once published.

## Start here

- [Quickstart](./quickstart/index.md) — install, write a workflow, run it. About 5 minutes.

## Concepts

- [Workflows](./concepts/workflows.md) — what a workflow is and how it composes
- [Steps](./concepts/steps.md) — the step kinds and when to use each
- [Context](./concepts/context.md) — the typed state that flows through a workflow
- [Agents](./concepts/agents.md) — the `agent()` step and agent definitions
- [Skills](./concepts/skills.md) — packaged capability units (`SKILL.md`)
- [Workspaces](./concepts/workspaces.md) — per-agent filesystem roots
- [Permissions](./concepts/permissions.md) — default-deny security model
- [State](./concepts/state.md) — KV state, journals, idempotency
- [Schedules](./concepts/schedules.md) — scheduler-native execution
- [Runs](./concepts/runs.md) — lifecycle, events, history
- [Observability](./concepts/observability.md) — events, metrics, audit, OpenTelemetry

## Recipes

Complete, runnable workflows for the patterns customers ship most often:

- [Coding agent on chat](./recipes/coding-agent-on-chat.md) — long-running coding workflow reachable via webhook
- [Ticket to PR](./recipes/ticket-to-pr.md) — autonomous ticket-watcher that opens PRs
- [Email triage](./recipes/email-triage.md) — classify, summarize, journal
- [HTTP enrichment](./recipes/http-enrichment.md) — sync HTTP-triggered workflow with LLM enrichment

## Reference

- [API](./reference/api.md) — `@skelm/core` public surface
- [CLI](./reference/cli.md) — every command, flag, exit code
- [HTTP](./reference/http.md) — endpoints, auth, errors, SSE
- [Configuration](./reference/config.md) — `skelm.config.ts` schema
- [Providers](./backends/README.md) — ModelProvider and AgentProvider architecture
- [Agent definitions](./reference/agent-definitions.md) — `AGENTS.md` / `SOUL.md` / `MEMORY.md` / `EXAMPLES.md`
- [Event schema](./reference/events.md)
- [Audit categories](./reference/audit.md)
- [Exit codes](./reference/exit-codes.md)
- [Glossary](./reference/glossary.md)

## Guides

- [Testing workflows](./guides/testing-workflows.md)
- [Writing a backend](./guides/writing-a-backend.md)
- [Writing a plugin](./guides/writing-a-plugin.md)
- [Authoring tips](./guides/authoring-tips.md)
- [Upgrading](./guides/upgrading.md)
- [Troubleshooting](./guides/troubleshooting.md)

## Deployment

- [systemd](./deployment/systemd.md) — install the gateway as a user unit
- [Reverse proxy](./deployment/reverse-proxy.md) — TLS and auth in front of the gateway
- [Postgres](./deployment/postgres.md) — production storage backend (M4)
- [Secrets](./deployment/secrets.md) — env, file, vault drivers
- [Monitoring](./deployment/monitoring.md) — Prometheus rules, OTel
- [Backup](./deployment/backup.md)

## About

- [Tenets](./about/tenets.md) — security, maintenance, robustness
- [Roadmap](./about/roadmap.md)
- [Changelog](./about/changelog.md) — generated
- [License](../LICENSE)

## Status

skelm is in early development. APIs are unstable until v1. Roadmap milestones (M1–M4) ship features in this order: core runtime + CLI → control flow + workspaces + state → gateway + audit + scheduler → integrations + agent routing + Postgres. See [the roadmap](./about/roadmap.md).
