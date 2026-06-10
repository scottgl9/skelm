<p align="center">
  <img src="docs/public/banner.svg" alt="skelm banner" />
</p>

<p align="center">
  <strong>Agentic workflows you can actually ship to production.</strong><br/>
  Typed TypeScript pipelines · default-deny permissions · a gateway you own.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/skelm"><img src="https://img.shields.io/npm/v/skelm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/skelm"><img src="https://img.shields.io/npm/dm/skelm" alt="npm downloads" /></a>
  <a href="https://scottgl9.github.io/skelm/"><img src="https://img.shields.io/badge/docs-online-blue" alt="Docs" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
  <a href="https://github.com/scottgl9/skelm/stargazers"><img src="https://img.shields.io/github/stars/scottgl9/skelm" alt="GitHub stars" /></a>
</p>

---

## Why skelm?

Most agent frameworks make it easy to demo a chatbot and impossible to operate one. Tool calls leak credentials, prompts mutate at runtime, and the production story is "trust us." Visual automation tools hide everything in a node graph that can't be diffed, code-reviewed, or unit-tested. Long-running orchestration engines force you to learn a separate runtime, separate DSL, and separate operational model for every kind of work. **skelm collapses those into one.** Every privileged action — exec, network, filesystem, tool dispatch, MCP — flows through a gateway under permissions you declare in code. Every workflow is a typed module you can grep, refactor, and unit-test.

**One authoring model spans the spectrum.** A two-second deterministic transform, a five-minute agent loop, a webhook-triggered service, a cron job, a multi-day workflow that pauses for human approval and resumes after a restart, and a **persistent chat workflow** whose conversation outlives every restart — all the same module shape, all the same gateway, all the same permissions. No second runtime to stand up when "quick automation" grows into "durable workflow," and no node-graph editor when "durable workflow" needs version control, code review, or a real test suite.

skelm runs on your own infrastructure with security primitives that don't disappear when the demo ends. That's what it's for.

---

## A workflow at a glance

```ts
import { agent, code, parallel, pipeline } from 'skelm'
import { z } from 'zod'

const Input = z.object({
  incidentId: z.string(),
  service: z.string(),
  description: z.string(),
})
type Input = z.infer<typeof Input>

export default pipeline({
  id: 'incident-response',
  input: Input,
  output: z.object({ rootCause: z.string(), immediateActions: z.array(z.string()) }),
  triggers: [{ kind: 'webhook', path: '/webhooks/incident' }],
  steps: [
    parallel({
      id: 'triage',
      steps: [
        code({
          id: 'search-issues',
          run: async (ctx) => {
            const { service } = ctx.input as Input
            return { issues: [{ title: `[${service}] latency`, url: '…' }] }
          },
        }),
        code({
          id: 'open-channel',
          run: async (ctx) => {
            const { incidentId } = ctx.input as Input
            return { channel: `inc-${incidentId.toLowerCase()}` }
          },
        }),
      ],
    }),
    agent({
      id: 'root-cause',
      backend: 'opencode',
      permissions: {
        allowedTools: ['gh.search_issues', 'slack.post_message'],
        allowedMcpServers: ['github'],
        allowedSkills: ['sre-runbook'],
        // Or set allowDefaultSafeExecutables in skelm.config.ts defaults.
        allowedExecutables: [],
        fsRead: [],
        fsWrite: [],
        networkEgress: { allowHosts: ['api.github.com', 'slack.com'] },
      },
      prompt: (ctx) => {
        const { service, description } = ctx.input as Input
        return `Analyze this ${service} incident and propose 2-3 actions:\n${description}`
      },
      output: z.object({ rootCause: z.string(), immediateActions: z.array(z.string()) }),
      maxTurns: 4,
    }),
  ],
})
```

A real module. Type-checked. Permissions enforced by the gateway. Schedulable, webhook-triggerable, and pause-resumable out of the box. Adapted from [`examples/incident-response/`](./examples/incident-response/).

### …or a persistent workflow you talk *through*

When the work isn't "fire once and finish" but "the same conversation, for as long as the user keeps talking," reach for `persistentWorkflow`. Each inbound message runs a fresh preamble and then exactly one session-keyed agent turn whose conversation lives in durable storage — restart the gateway and the next message picks up the same thread.

```ts
import { code, persistentWorkflow } from 'skelm'

export default persistentWorkflow({
  id: 'support-bot',
  triggers: [{ kind: 'queue', sourceId: 'telegram' }],
  steps: [
    code({ id: 'prepare', run: (ctx) => ({ text: `[${ctx.input.from}] ${ctx.input.text}` }) }),
  ],
  agent: {
    backend: 'pi',
    system: 'You are a concise support assistant.',
    sessionKey: (msg) => msg.chatId,        // one durable session per chat
    prompt: (ctx) => ctx.steps.prepare.text,
  },
})
```

Same trust boundary, same permission model, same event log as a one-shot pipeline — just with a conversation that outlives any single trigger fire. See [persistent workflows](./docs/concepts/persistent-workflows.md).

---

## Features

| Security & trust | Authoring & flexibility | Runtime & operations |
|---|---|---|
| 🔒 **Default-deny by design** — every step declares its tools, executables, MCP servers, network egress, and filesystem roots. Anything not listed is denied. The gateway is the only thing that enforces it. | 🧠 **Code-first, not config-first** — pipelines are real `.mts` modules. Refactor with your editor, type-check with `tsc`, version with git, test with vitest. No YAML DSL to learn. | ⏱ **Durable wait/resume** — workflows pause for hours, days, or webhooks and resume on a deterministic event log. Survives restarts. |
| 🌐 **Gateway-hosted runtime** — a long-running gateway hosts pipelines over HTTP + SSE, drives the scheduler, manages MCP-server lifecycles, and owns the trust boundary. Nothing privileged runs outside it. | 🧩 **Backend-agnostic agents** — Opencode, ACP (Copilot, Claude Code), OpenAI, Anthropic, Codex, Pi, Vercel AI. Swap providers without rewriting a step. | 💬 **Persistent workflows** — `persistentWorkflow` turns any trigger source (chat, queue, cron) into a long-lived, session-keyed conversation that survives restarts. Pairs with optional [agentmemory](https://github.com/rohitg00/agentmemory) for cross-session recall via `@skelm/agentmemory`. |
| 💾 **Self-hosted, local-first** — SQLite + filesystem out of the box; Postgres and external vaults for production. No managed cloud, no telemetry, no vendor lock-in. | 📚 **Skills-first capability model** — package procedural knowledge as `SKILL.md` bundles the agent loads on demand. MCP servers plug in as first-class registry citizens. | 🖼 **Multimodal** — `infer()` and `agent()` accept image parts; vision routes to vision-capable backends, denied at step start for the rest. Screenshots persist as `ctx.artifacts`. |

---

## Quick start

```bash
# Install the CLI
npm install -g skelm

# Scaffold a project
skelm init my-bot && cd my-bot && npm install

# Run your first workflow
skelm run workflows/hello.workflow.mts --input '{"name":"world"}'
```

`skelm run` dispatches to a local **gateway** process. If none is running the CLI auto-starts one in the background; for a supervised service that survives reboots:

```bash
skelm gateway install --systemd   # linux
skelm gateway install --launchd   # macOS
```

Schedule it, expose it over HTTP, or wire it to a webhook:

```bash
skelm schedule add workflows/hello.workflow.mts --cron '0 * * * *'
skelm gateway start --foreground
```

📖 **Next:** [Quickstart guide](./docs/quickstart/README.md)

### Build workflows with `skelm builder`

Prefer to start from a spec instead of a blank `.mts` file? `skelm builder`
scaffolds a conversational workflow-builder project and opens a terminal chat UI.
Describe the workflow you want; the builder uses the bundled `skelm` skill,
writes a `*.workflow.mts`, and validates it with `skelm validate`.

```bash
skelm builder
cd builder && npm install
skelm builder
```

The builder is itself a `persistentWorkflow`, runs through the same gateway
permission model as any other skelm workflow, and uses Codex by default with a
pi-sdk fallback. See [Building Workflows](./docs/guides/building-workflows.md#the-skelm-builder).

---

## How skelm compares

|  | Agent SDKs | Durable orchestrators | Visual automation | **skelm** |
|---|:---:|:---:|:---:|:---:|
| One model: ephemeral runs, durable workflows, *and* persistent chat agents | partial | partial | no    | **yes** |
| Session-keyed conversation state that survives restarts          | partial | partial | no    | **yes** |
| Typed code you can grep, diff, and unit-test         | partial | yes     | no    | **yes** |
| Durable wait / resume across restarts                | partial | yes     | partial | **yes** |
| Default-deny permissions enforced at runtime         | no      | no      | no    | **yes** |
| Self-hosted gateway as trust boundary                | no      | n/a     | no    | **yes** |
| Multi-backend agents (Opencode, Codex, Pi, ACP, …)   | n/a     | no      | no    | **yes** |
| MCP servers lifecycle-managed                        | partial | no      | partial | **yes** |
| Built-in scheduler · webhook · queue · file-watch triggers | no | partial | yes | **yes** |
| No managed cloud, no node graph, no vendor lock-in   | yes     | no      | no    | **yes** |

You shouldn't need three different tools — a one-off agent script, a durable workflow engine, and a visual integration builder — to cover the work one team actually does. skelm is one framework, one runtime, one trust boundary, end to end.

---

## Backend support

| Backend | Package | Best for |
|---|---|---|
| **First-party** | `@skelm/agent` | OpenAI-compatible LLM, in-process permission enforcement, built-in tool surface |
| **Pi** | `@skelm/pi` | Pi coding agent with full permission enforcement |
| **Opencode** | `@skelm/opencode` | Open-source coding agent backend (native or ACP) |
| **Codex** | `@skelm/codex` | OpenAI Codex via the official `@openai/codex-sdk`, sandbox-aware |
| **Vercel AI** | `@skelm/vercel-ai` | Vercel AI SDK with streaming |
| **ACP** | Built-in | GitHub Copilot, Claude Code via [Agent Client Protocol](https://agentclientprotocol.com) |

See [Backend documentation](./docs/backends/README.md) for setup.

---

## Core concepts

**Step kinds:** `code()` (deterministic), `infer()` (single LLM call), `agent()` (multi-turn loop with tools, MCP, and skills).

**Control flow:** `parallel`, `forEach`, `branch`, `loop`, `wait`, `invoke`.

**Security model:** default-deny permissions, an embedded CONNECT proxy that blocks undeclared network egress, per-agent workspaces with isolated filesystem roots, and a hash-chained tamper-evident audit journal.

---

## What you can build

- **Chat bots and always-on assistants** — `persistentWorkflow` keeps the conversation alive across messages and restarts (Telegram, Matrix, in-app chat — see the [persistent workflow recipes](./docs/recipes/))
- **Coding assistants** that open PRs in persistent workspaces
- **Queue workers** that watch Jira, GitHub, or email and act on tickets
- **Email triage** that classifies, summarizes, and journals decisions for audit
- **Digest automation** — fan out, enrich with LLM, post to Slack
- **HTTP webhooks** as typed workflows triggered by external events
- **Research agents** that poll sources, store findings, resume after restart
- **Compliance bots** that watch S3 buckets, run checks, escalate to agents
- **UI automation** — vision LLM + screenshot artifacts; see the [foundations recipe](./docs/recipes/ui-automation-foundations.md)

📁 [`examples/`](./examples/) has runnable starting points for each.

---

## Documentation

- **[Quickstart](./docs/quickstart/README.md)** — get started in 60 seconds
- **[Backends](./docs/backends/README.md)** — provider architecture and setup
- **[Guides](./docs/guides/)** — testing, plugins, authoring patterns
- **[Recipes](./docs/recipes/)** — complete workflow examples
- **[Reference](./docs/reference/)** — CLI, HTTP API, OpenAPI spec
- **[Packages](./docs/reference/packages.md)** — package map and responsibilities
- **[Contributing](./.github/CONTRIBUTING.md)** — PRs welcome

---

## Tested against itself

skelm is verified by [**skelm-self-test**](https://github.com/scottgl9/skelm-self-test), a live agentic harness that runs skelm workflows to test skelm — no external test runner required.

```bash
pnpm install
skelm run workflows/test-runner.workflow.mts
cat results/latest.md
```

---

## Community & status

- [GitHub Discussions](https://github.com/scottgl9/skelm/discussions) — questions, show & tell
- [Issues](https://github.com/scottgl9/skelm/issues) — bugs and feature requests
- [Contributing](./.github/CONTRIBUTING.md) — PRs welcome

> **Status:** Early development. APIs are unstable until v1. If skelm's tenets resonate, a star helps more people find the project — and feedback shapes what v1 looks like.

---

## License

[MIT](LICENSE)
