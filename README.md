<p align="center">
  <img src="docs/public/banner.svg" alt="skelm banner" />
</p>

<p align="center">
  <strong>Build secure, agentic workflows in TypeScript. Run them anywhere Node runs.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/skelm"><img src="https://img.shields.io/npm/v/skelm" alt="npm version" /></a>
  <a href="https://scottgl9.github.io/skelm/"><img src="https://img.shields.io/badge/docs-online-blue" alt="Docs" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
  <a href="https://github.com/scottgl9/skelm/stargazers"><img src="https://img.shields.io/github/stars/scottgl9/skelm" alt="GitHub stars" /></a>
</p>

---

## What is skelm?

skelm is a TypeScript framework for authoring and running **workflows** — typed orchestrations that mix deterministic code, LLM inference, and full agent loops behind a secure, default-deny execution model.

**Key capabilities:**

- **TypeScript-native** — Real `.ts` modules, no DSL or JSON config
- **Default-deny security** — Every permission must be explicitly declared
- **Multi-backend agents** — First-party agent, Pi, Opencode (native or ACP), Codex, Vercel AI, ACP (Copilot, Claude Code, Gemini), Anthropic, OpenAI
- **MCP-native** — Model Context Protocol servers lifecycle-managed by the gateway
- **Skill support** — Reusable `SKILL.md` capability bundles injected into agent system prompts; permission-gated via `allowedSkills`; auto-discovered from `skills/**/SKILL.md` by the gateway registry
- **Scheduler-built-in** — Cron, intervals, webhooks, polling, queues, or long-running gateway service

> **Status:** Early development. APIs are unstable until v1. Feedback and contributions welcome.

---

## Quick start

```bash
# Install the CLI
npm install -g skelm

# Scaffold a project
skelm init my-bot && cd my-bot && npm install

# Run your first workflow
skelm run workflows/hello.workflow.ts --input '{"name":"world"}'
```

That's it. From here you can edit workflows, add agent steps, schedule them, or stand up the gateway:

```bash
skelm schedule add workflows/hello.workflow.ts --cron '0 * * * *'  # cron job
skelm gateway start                                                # long-running service
```

📖 **Next:** [Quickstart guide](./docs/quickstart/README.md)

---

## Backend support

skelm supports multiple AI backends through pluggable adapters. Choose the one that fits your use case:

| Backend | Package | Best for |
|---------|---------|----------|
| **First-party** | `@skelm/agent` | OpenAI-compatible LLM, in-process permission enforcement, built-in tool surface, no external runtime dependency |
| **Pi** | `@skelm/pi` | Pi coding agent with full permission enforcement |
| **Opencode** | `@skelm/opencode` | Open-source coding agent backend (native; ACP transport also supported) |
| **Codex** | `@skelm/codex` | OpenAI Codex via the official `@openai/codex-sdk` — sandbox-aware (`read-only` / `workspace-write`), MCP + skills injection, streaming, thread resumption |
| **Vercel AI** | `@skelm/vercel-ai` | Vercel AI SDK with streaming support |
| **ACP** | Built-in | GitHub Copilot, Claude Code, Gemini via ACP (Opencode also available as native — see above) |

See [Backend documentation](./docs/backends/README.md) for setup guides, and [Codex backend](./docs/backends/codex.md) for OpenAI Codex specifically. Codex authenticates via the host `codex` CLI (`codex login`) or `CODEX_API_KEY`; skelm validates permissions at the boundary while Codex enforces its sandbox in-process.

---

## Core concepts

### Workflow step kinds

- **`code()`** — Deterministic logic, API calls, data transformation
- **`llm()`** — Single LLM inference call
- **`agent()`** — Multi-turn agent loops with tools, MCP, and skills

### Control flow primitives

- **`parallel`** — Run steps concurrently
- **`forEach`** — Iterate over collections
- **`branch`** — Conditional execution
- **`loop`** — Repeat with exit conditions
- **`wait`** — Pause and resume later
- **`invoke`** — Call another pipeline by ID

### Security model

- **Default-deny permissions** — Tools, MCP servers, network hosts, filesystem roots must be declared
- **Network egress enforcement** — Embedded CONNECT proxy blocks undeclared outbound connections
- **Per-agent workspaces** — Isolated filesystem roots prevent cross-step corruption
- **Tamper-evident audit** — Hash-chained decision journals for compliance

---

## What you can build

- **Coding assistants** — Reachable on chat, open PRs in persistent workspaces
- **Queue workers** — Watch Jira, GitHub, or email and act on tickets
- **Email triage** — Classify, summarize, and journal decisions for audit
- **Digest automation** — Fan out, enrich with LLM, post to Slack
- **HTTP webhooks** — Typed workflows triggered by external events
- **Research agents** — Poll sources, store findings, resume after restart
- **Compliance bots** — Watch S3 buckets, run checks, escalate to agents

📁 See [`examples/`](./examples/) for runnable starting points.

---

## Package architecture

| Package | Purpose |
|---------|---------|
| `skelm` | Meta-package — install this, re-exports `@skelm/core` + CLI |
| `@skelm/core` | Runtime, types, builders, permission model, event bus |
| `@skelm/cli` | CLI commands — `run`, `schedule`, `gateway`, `audit` |
| `@skelm/gateway` | Long-running orchestrator: HTTP, scheduler, agent lifecycle |
| `@skelm/scheduler` | Cron, interval, webhook, poll, queue triggers |
| `@skelm/integrations` | Typed connectors for GitHub, Slack, Telegram |
| `@skelm/integration-sdk` | Authoring SDK for building custom skelm integrations |
| `@skelm/pi` | Pi coding-agent backend |
| `@skelm/opencode` | Opencode coding-agent backend |
| `@skelm/codex` | OpenAI Codex backend via the official `@openai/codex-sdk` |
| `@skelm/vercel-ai` | Vercel AI SDK backend with streaming |
| `@skelm/agent` | First-party native agent backend with built-in tools |
| `@skelm/metrics` | Prometheus-format metrics |
| `@skelm/otel` | OpenTelemetry tracing |

---

## Documentation

- **[Quickstart](./docs/quickstart/README.md)** — Get started in 60 seconds
- **[Backends](./docs/backends/README.md)** — Provider architecture and setup
- **[Guides](./docs/guides/)** — Testing, plugins, authoring patterns
- **[Recipes](./docs/recipes/)** — Complete workflow examples
- **[Reference](./docs/reference/)** — CLI, HTTP API, OpenAPI spec
- **[Contributing](./.github/CONTRIBUTING.md)** — How to contribute

---

## Community

- [GitHub Discussions](https://github.com/scottgl9/skelm/discussions) — Questions and show & tell
- [Issues](https://github.com/scottgl9/skelm/issues) — Bug reports and feature requests
- [Contributing](./.github/CONTRIBUTING.md) — PRs welcome

---

## License

[MIT](LICENSE)
