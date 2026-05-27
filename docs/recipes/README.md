# Recipes

Complete, runnable workflows for the patterns customers ship most often. Each recipe is a self-contained project: full `skelm.config.ts`, full workflow, agent definitions where used, schedule registration, and a "why each piece is here" section explaining the trade-offs.

## Chat bots & persistent workflows

- **[Telegram persistent workflow](./telegram-persistent-workflow.md)** — a chat bot you talk *through*: one durable conversation per chat, surviving restarts, optionally freewheeling via the operator-gated unrestricted bypass. The canonical persistent-workflow pattern, with a `code()` preamble.
- **[TUI persistent workflow](./tui-persistent-workflow.md)** — the same pattern driven from a local terminal UI, and the minimal persistent-workflow shape (no preamble, just the terminal agent).
- **[Matrix persistent agent](./matrix-persistent-agent.md)** — the same persistent-agent pattern over [Matrix](https://matrix.org): one durable conversation per room, with a who-can-talk allowlist and self-message (echo) filtering. Unencrypted rooms.

## Long-running scheduled workflows

- **[Coding agent on chat](./coding-agent-on-chat.md)** — webhook-triggered coding workflow with a persistent repo workspace. Receives chat messages, opens PRs, replies. The canonical "long-running agent reachable via chat" pattern.
- **[Ticket to PR](./ticket-to-pr.md)** — poll-triggered queue worker. For each new ticket, attempts the change in a per-repo persistent workspace and opens a PR. Demonstrates `forEach`, `compensate`, and per-item workspaces.
- **[Email triage](./email-triage.md)** — poll-triggered classifier. No agent loop; uses `infer()` with structured output. Demonstrates `forEach`, `branch`, decision journals, and a paired digest workflow.

## HTTP-triggered workflows

- **[HTTP enrichment](./http-enrichment.md)** — sync workflow called from existing infrastructure (queue worker, webhook). Deterministic normalization plus LLM classification, then posts to Slack. The simplest production-shaped pattern.

## UI / vision

- **[UI automation foundations](./ui-automation-foundations.md)** — multimodal prompts (screenshots in LLM calls) plus a binary artifact store on the run record. The two primitives a UI-test pipeline cannot build on its own.

## Observability

- **[OpenTelemetry traces](./otel-exporter.md)** — wire `@skelm/otel` to any OTLP-compatible collector (Tempo, Jaeger, Honeycomb, Datadog). The adapter records spans; you bring the exporter.

## How to use these

Every recipe has the same shape:

1. **Project layout** — what files go where.
2. **Config** — `skelm.config.ts` with default-deny permissions, backends, secrets, server config.
3. **Sources / agents / skills** — supporting markdown and TypeScript.
4. **Workflow** — the full TypeScript module.
5. **Schedule it** — the CLI invocation that wires the workflow to a trigger.
6. **Why each piece is here** — the design choices and trade-offs.
7. **Observability** — how to inspect what happened after the fact.

Recipes are kept tight: each is a working project, not a tutorial. If you want the conceptual background, read [Concepts](../concepts/) first; if you want to ship the pattern, copy the recipe and adjust.

## Choosing a recipe

| Question                                           | Start here                                                |
| -------------------------------------------------- | --------------------------------------------------------- |
| "I want a chat-reachable bot that codes."          | [Coding agent on chat](./coding-agent-on-chat.md)         |
| "I want to autonomously work a ticket queue."      | [Ticket to PR](./ticket-to-pr.md)                         |
| "I want to triage / digest a stream of items."     | [Email triage](./email-triage.md)                         |
| "I want to add LLM enrichment to my existing API." | [HTTP enrichment](./http-enrichment.md)                   |

If your shape is none of these, mix and match. A workflow is just a typed orchestration; the recipes are not normative.

## Common patterns across recipes

- **Default-deny permissions.** Every agent step declares exactly what it can do. There is no implicit access.
- **Idempotency at the right layer.** HTTP-triggered workflows use `Idempotency-Key`; long-running ones use `ctx.state.cas` or watermarks; queue-driven ones use the scheduler's `dedupeKey`.
- **Decision journals.** Long-running workflows append to `ctx.state.append('decisions', ...)` so a human can review what the workflow has done over time without scrolling chat history.
- **Structured output on `infer()` and `agent()`.** The runtime validates and the consuming `code()` step does not have to guess at parsing.
- **Workspaces for filesystem state, KV state for structured decisions, run history for behavior, audit for security.** Four artifacts; one per question.
