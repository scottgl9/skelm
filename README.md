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
skelm init my-bot && cd my-bot
```

You get a working project: one example workflow, an `AGENTS.md` agent definition, a `SKILL.md` skill package, and a `skelm.config.ts` with default-deny permissions.

**3. Run your first workflow.**

```bash
skelm run workflows/hello.workflow.ts
```

That's it. From here you can edit the workflow, add steps, schedule it, or stand up the gateway:

```bash
skelm run workflows/hello.workflow.ts --input '{"name":"world"}'   # one-off run
skelm schedule add workflows/hello.workflow.ts --cron '0 * * * *'  # cron
skelm gateway start                                                # long-running service
```

📖 **Next:** the [quickstart](./docs/quickstart/index.md) walks through writing your second workflow with an LLM call.

---

## Main features

- **TypeScript-native workflows.** Real `.ts` modules — refactor, test, type-check, version like any other code. No DSL, no JSON config.
- **Three step kinds, none wrapping another.** `code()` for deterministic logic, `llm()` for single inference calls, `agent()` for full multi-turn loops.
- **Default-deny security.** Every agent step declares the tools, MCP servers, network hosts, and filesystem roots it may use. Anything undeclared is denied.
- **Multi-backend agents.** Opencode, ACP (Copilot, Claude Code, Gemini), OpenAI, Anthropic, Pi — plus a provider SPI for custom backends.
- **MCP-native.** Model Context Protocol servers are first-class registry citizens, lifecycle-managed by the gateway.
- **Native control flow.** `parallel`, `forEach`, `branch`, `loop`, `wait`, and nested pipelines are core, not add-ons.
- **Scheduler-native.** Every run is a schedule — immediate, cron, interval, webhook, poll, or queue.
- **Per-agent workspaces.** Each agent step gets its own filesystem root, persistent or ephemeral, locked against corruption.
- **Persistent state and audit.** Typed KV store, append-only decision journals, idempotency primitives, and a hash-chained tamper-evident audit log.
- **Long-running gateway.** Hosts workflows over HTTP + SSE, drives the scheduler, owns the trust boundary.
- **Local-first.** SQLite by default; Postgres + vault drivers for production. No managed cloud, no telemetry.
- **Markdown agent definitions.** `AGENTS.md` for role, `SOUL.md` for persona, `SKILL.md` for capabilities — reviewable in PRs.

## What you can build

If you have written any of these as a hand-rolled script, you have felt skelm-shaped pain:

- A coding assistant reachable on chat that opens PRs in a persistent repo workspace.
- A queue worker that watches Jira and tries to ship the ticket.
- An email-triage agent that classifies, summarizes, and journals decisions you can audit.
- A nightly digest that fans out, enriches with an LLM, and posts to Slack.
- An HTTP endpoint that runs a typed workflow with three deterministic steps and one LLM call.

skelm gives you one substrate for all five.

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
- **Reference:** [`docs/reference/`](./docs/reference/) — API, CLI, HTTP, configuration schemas
- **Deployment:** [`docs/deployment/`](./docs/deployment/) — systemd, reverse proxy, Postgres, secrets
- **Contributors:** [`AGENTS.md`](./AGENTS.md) — workflow, code style, testing expectations
- **Changelog:** [`CHANGELOG.md`](./CHANGELOG.md) — version history
- **Security policy:** [`SECURITY.md`](./SECURITY.md) — reporting vulnerabilities

## Community

- [GitHub Discussions](https://github.com/scottgl9/skelm/discussions) — questions, ideas, show & tell
- [Issues](https://github.com/scottgl9/skelm/issues) — bug reports and feature requests
- [Contributing](CONTRIBUTING.md) — PRs welcome

The framework dogfoods itself: skelm's own pre-merge review and unit-test generation run as skelm workflows under [`pipelines/internal/`](./pipelines/internal/). Reading those is a good way to learn the API and see how the security tenet works in practice.

---

## A real workflow, end to end

Here is a workflow that triages a GitHub issue: a deterministic `code()` step fetches it, then an `agent()` step classifies it under tight default-deny permissions.

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
        const res = await fetch(`https://api.github.com/repos/${ctx.input.repo}/issues/${ctx.input.issueNumber}`)
        return await res.json()
      },
    }),
    agent({
      id: 'classify',
      backend: 'anthropic',
      agentDef: './agents/triager',
      skills:  ['github-readonly'],
      mcp:     [{ id: 'gh', transport: 'stdio', command: 'mcp-github' }],
      permissions: {
        allowedTools:      ['gh.add_label'],
        allowedMcpServers: ['gh'],
        allowedSkills:     ['github-readonly'],
        networkEgress:     { allowHosts: ['api.github.com'] },
        fsRead:            ['./'],
        fsWrite:           [],
      },
      prompt: (ctx) => `Triage this issue:\n${JSON.stringify(ctx.steps.fetch)}`,
      output: z.object({ label: z.enum(['bug','feature','duplicate']), reasoning: z.string() }),
      maxTurns: 8,
    }),
  ],
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

[MIT](LICENSE). Copyright © Scott Glover.

If you build something interesting on skelm, we want to hear about it — open an issue with the `showcase` label.
