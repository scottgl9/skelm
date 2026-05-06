<p align="center">
  <img src="docs/public/logo.svg" alt="skelm logo" width="120" height="120" />
</p>

<h1 align="center">skelm</h1>

<p align="center">
  <strong>Build secure, agentic, long-running workflows in TypeScript. Run them anywhere Node runs.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/skelm"><img src="https://img.shields.io/npm/v/skelm" alt="npm version" /></a>
  <a href="https://github.com/scottgl9/skelm/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
  <a href="https://github.com/scottgl9/skelm/stargazers"><img src="https://img.shields.io/github/stars/scottgl9/skelm" alt="GitHub stars" /></a>
</p>

skelm is a TypeScript framework for authoring, running, and operating **workflows** — typed orchestrations that mix deterministic code, LLM inference, and full agent loops behind a single, secure, default-deny execution model. Every workflow is schedulable: fire one once, schedule it on cron, register a webhook, or let it run continuously inside a long-lived gateway service.

> **Status:** early development. APIs are unstable until v1. Star the repo, open issues, contribute fixes — feedback now is the most valuable feedback.

---

## Get started in 60 seconds

**1. Install the CLI.**

```bash
npm install -g skelm
```

**2. Scaffold a project.**

```bash
skelm init my-bot && cd my-bot && npm install
```

You get a working project: an example `hello` workflow under `workflows/`, a `skelm.config.ts` with default-deny permissions, a `package.json`, a `tsconfig.json`, and a `.gitignore`.

**3. Run your first workflow.**

```bash
skelm run workflows/hello.workflow.ts --input '{"name":"world"}'
```

That's it. From here you can edit the workflow, add steps, schedule it, or stand up the gateway:

```bash
skelm schedule add workflows/hello.workflow.ts --cron '0 * * * *'  # cron
skelm gateway start                                                # long-running service
```

📖 **Next:** the [quickstart](./docs/quickstart/index.md) walks through writing your second workflow with an LLM call.

---

## Main features

A workflow is a typed TypeScript module made of three step kinds (`code`, `llm`, `agent`). The gateway hosts workflows, drives the scheduler, enforces default-deny permissions, and brokers everything privileged — backends, MCP servers, integrations.

### Authoring

- **TypeScript-native workflows.** Real `.ts` modules — refactor, test, type-check, and version like any other code. No DSL, no JSON config.
- **Three step kinds, none wrapping another.** `code()` for deterministic logic, `llm()` for single inference calls, `agent()` for full multi-turn loops.
- **Native control flow.** `parallel`, `forEach`, `branch`, `loop`, `wait`, and nested pipelines are core primitives, not add-ons.
- **Markdown agent definitions.** `AGENTS.md` for role, `SOUL.md` for persona, `SKILL.md` for capabilities — reviewable in PRs.

### Security & isolation

- **Default-deny everywhere.** Every agent step declares the tools, MCP servers, network hosts, and filesystem roots it may use. Anything undeclared is denied at step start.
- **Per-agent workspaces.** Each agent step gets its own filesystem root — persistent or ephemeral — locked against cross-step corruption.
- **Persistent state and tamper-evident audit.** Typed KV store, append-only decision journals, idempotency primitives, and a hash-chained audit log.

### Integrations

- **Multi-backend agents.** Opencode, ACP (Copilot, Claude Code, Gemini), OpenAI, Anthropic, Pi — plus a provider SPI for custom backends.
- **MCP-native.** Model Context Protocol servers are first-class registry citizens, lifecycle-managed by the gateway.
- **CLI tools as first-class tools.** Agents can shell out to any CLI binary (`gh`, `kubectl`, `psql`, `ffmpeg`, your own scripts) — declared in `allowedTools`, scoped to the agent's workspace, and gated by the same default-deny permissions as everything else.

### Operations

- **Scheduler-native.** Every run is a schedule — immediate, cron, interval, webhook, poll, or queue.
- **Long-running gateway.** Hosts workflows over HTTP + SSE, drives the scheduler, owns the trust boundary.
- **Local-first.** SQLite by default; Postgres + vault drivers for production. No managed cloud, no telemetry.

## What you can build

Build **agents**, along with deterministic steps and one-shot LLM calls, into robust workflows on any trigger or schedule. Here are a few examples:

- A coding assistant reachable on chat that opens PRs in a persistent repo workspace.
- A queue worker that watches Jira and tries to ship the ticket.
- An email-triage agent that classifies, summarizes, and journals decisions you can audit.
- A nightly digest that fans out, enriches with an LLM, and posts to Slack.
- An HTTP endpoint that runs a typed workflow with three deterministic steps and one LLM call.
- A long-lived research agent that polls sources, stores findings in typed KV, and resumes after restart.
- A compliance bot that watches an S3 bucket via webhook and runs deterministic checks before escalating to an agent.
- An on-call responder that fans out to multiple LLM backends in parallel and reconciles their answers.

If your workflow has any combination of triggers, branching, retries, agents, tools, audit, or scheduling — skelm is the substrate.

Runnable starting points live under [`examples/`](./examples/) — including [`examples/telegram-bot/`](./examples/telegram-bot/README.md), a long-poll Telegram bot driving an `agent()` step on the pi backend.

## Three tenets, in this order

1. **Security.** Default-deny everywhere. A backend that cannot enforce a declared permission fails at step start instead of bypassing it. The gateway is the single trust boundary; nothing privileged happens outside it.
2. **Maintenance.** A small core, a narrow public surface, no DSL. Workflows are TypeScript modules.
3. **Robustness.** Typed context end-to-end. Explicit error semantics. Deterministic event log. Durable wait/resume. Persistent state and per-agent workspaces that survive restarts.

These outrank everything else. We will ship a smaller framework that is secure, maintainable, and robust before we ship a larger one that is not.

## How it compares

|                          | skelm                                            | LangChain        | CrewAI         | n8n               |
| ------------------------ | :----------------------------------------------: | :--------------: | :------------: | :---------------: |
| Workflow format          | TypeScript modules                               | Python code      | Python code    | JSON              |
| Default-deny permissions | ✅ Structural — part of the API                  | ❌                | ❌              | Plugin            |
| Per-agent workspaces     | ✅ Locked, persistent or ephemeral               | ❌                | ❌              | ❌                 |
| Tamper-evident audit log | ✅ Hash-chained                                  | ❌                | ❌              | ❌                 |
| Long-running gateway     | ✅ HTTP + SSE + scheduler                        | Self-build       | Self-build     | ✅                 |
| Multi-backend agents     | ✅ ACP + SDK + provider SPI                      | ✅                | ✅              | Plugin            |
| MCP-native               | ✅ Lifecycle-managed                             | Adapter          | Adapter        | ❌                 |
| Self-hosted              | ✅                                               | ✅                | ✅              | ✅                 |
| Telemetry                | None                                             | Opt-out          | Opt-out        | Varies            |
| License                  | MIT                                              | MIT              | MIT            | Sustainable Use   |

## Packages

| Package                                             | Description                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| [`skelm`](packages/skelm)                           | Meta-package — install this. Re-exports `@skelm/core` + ships the bin  |
| [`@skelm/core`](packages/core)                      | Runtime, types, builders, permission model, event bus                  |
| [`@skelm/cli`](packages/cli)                        | CLI primitives — parser, commands, programmatic entry point            |
| [`@skelm/gateway`](packages/gateway)                | Long-running orchestrator: HTTP, registries, audit, agent lifecycle    |
| [`@skelm/scheduler`](packages/scheduler)            | Cron / interval / webhook / poll / queue triggers                      |
| [`@skelm/integrations`](packages/integrations)      | Typed connectors for GitHub, Slack, and friends                        |
| [`@skelm/opencode`](packages/opencode)              | Opencode coding-agent backend with full permission enforcement         |
| [`@skelm/pi`](packages/pi)                          | Pi coding-agent backend with full permission enforcement               |
| [`@skelm/metrics`](packages/metrics)                | Prometheus-format metrics for skelm event streams                      |
| [`@skelm/otel`](packages/otel)                      | OpenTelemetry tracing for skelm event streams                          |

## Documentation

Customer-facing docs live under [`docs/`](./docs/) — quickstart, full CLI/API/HTTP reference, deployment guides, recipes for common workflow shapes.

- **Quickstart:** [`docs/quickstart/index.md`](./docs/quickstart/index.md)
- **Provider architecture:** [`docs/backends/README.md`](./docs/backends/README.md)
- **Guides:** [`docs/guides/`](./docs/guides/) — testing, plugins, authoring tips
- **Recipes:** [`docs/recipes/`](./docs/recipes/) — complete workflow examples
- **Reference:** [`docs/reference/`](./docs/reference/) — [CLI](./docs/reference/cli.md), [HTTP](./docs/reference/http.md), [OpenAPI](./docs/reference/openapi.yaml), [API](./docs/reference/api.md)
- **Production hardening:** [`docs/guides/production-hardening.md`](./docs/guides/production-hardening.md) — checklist before exposing the gateway
- **Contributors:** [`AGENTS.md`](./AGENTS.md) — workflow, code style, testing expectations
- **Changelog:** [`CHANGELOG.md`](./CHANGELOG.md) — version history
- **Security policy:** [`SECURITY.md`](./SECURITY.md) — reporting vulnerabilities

## Community

- [GitHub Discussions](https://github.com/scottgl9/skelm/discussions) — questions, ideas, show & tell
- [Issues](https://github.com/scottgl9/skelm/issues) — bug reports and feature requests
- [Contributing](CONTRIBUTING.md) — PRs welcome

---

## A real workflow, end to end

A workflow that triages a GitHub issue: a deterministic `code()` step fetches it, then an `agent()` step classifies it — guided by a **skill** that encodes your team's labeling criteria. Skills are reviewable Markdown files that skelm injects into the agent's context at runtime.

```
issue-triage/
├── skills/
│   └── triage-guide/
│       └── SKILL.md                   ← label criteria the agent follows
├── workflows/
│   └── triage-issue.workflow.ts
├── skelm.config.ts
└── package.json
```

**`skills/triage-guide/SKILL.md`**

```markdown
---
id: triage-guide
description: Label definitions and triage criteria for issue classification
---

# Issue triage guide

Apply exactly one label per issue:

- **bug** — reproducible defect; something worked before and now does not.
- **feature** — new capability request; nothing is broken.
- **duplicate** — same problem already tracked elsewhere; include the existing issue number.
- **security** — potential vulnerability; flag priority high regardless of other factors.
- **docs** — documentation error or omission only; no code change needed.

When the issue is ambiguous, prefer **bug** over **feature** and include your uncertainty in `reasoning`.
```

**`workflows/triage-issue.workflow.ts`**

```ts
import { pipeline, code, agent } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'triage-issue',
  input:  z.object({ repo: z.string(), issueNumber: z.number() }),
  output: z.object({ label: z.string(), reasoning: z.string() }),
  steps: [
    code({
      id: 'fetch',
      run: async (ctx) => {
        const res = await fetch(
          `https://api.github.com/repos/${ctx.input.repo}/issues/${ctx.input.issueNumber}`,
        )
        return await res.json()
      },
    }),
    agent({
      id: 'classify',
      backend: 'pi',
      skills: ['triage-guide'],          // inject the skill into the agent's context
      prompt: (ctx) =>
        `Triage this issue and return JSON with {label, reasoning}:\n${JSON.stringify(ctx.steps.fetch)}`,
      permissions: {
        allowedTools:       [],
        allowedExecutables: [],
        allowedMcpServers:  [],
        allowedSkills:      ['triage-guide'],
        networkEgress:      'deny',
        fsRead:             [],
        fsWrite:            [],
      },
      output: z.object({
        label:     z.enum(['bug', 'feature', 'duplicate', 'security', 'docs']),
        reasoning: z.string(),
      }),
      maxTurns: 3,
    }),
  ],
})
```

**`skelm.config.ts`**

```ts
import { defineConfig } from 'skelm'
import { createPiSdkBackend } from '@skelm/pi'

export default defineConfig({
  backends: { agent: 'pi' },
  instances: [createPiSdkBackend({ id: 'pi' })],
  registries: {
    skills: { glob: 'skills/**/SKILL.md' },  // where skelm discovers SKILL.md files
  },
})
```

Run it, schedule it, or expose it through the gateway:

```bash
# Run once
skelm run workflows/triage-issue.workflow.ts --input '{"repo":"acme/x","issueNumber":42}'

# Trigger from a webhook
skelm schedule add workflows/triage-issue.workflow.ts --webhook /webhooks/issue-events

# Or host it in the long-running gateway
skelm gateway start
```

## Author

Scott Glover — `scottgl@gmail.com`

## License

[MIT](LICENSE).

If you build something interesting on skelm, we want to hear about it — open an issue with the `showcase` label.
