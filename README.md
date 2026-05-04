# skelm

**Build secure, agentic, long-running workflows in TypeScript. Run them anywhere Node runs.**

skelm is an open-source TypeScript framework for authoring, running, and operating **workflows** — typed orchestrations that mix deterministic code, LLM inference, and agent loops behind a single, secure, default-deny execution model. Every workflow is schedulable: fire one once, schedule it on cron, register a webhook, or let it run continuously inside a long-lived gateway service.

> **Status:** early development. APIs are unstable until v1. Star the repo, open issues, contribute fixes — feedback now is the most valuable feedback.
>
> **Architecture:** the gateway-centric refactor (`feat/gateway-centric` branch) is landed end-to-end. `@skelm/gateway` is the long-running process that owns config, registries (workflows, skills, MCP servers, agents), enforcement (permissions, audit, secrets, approvals), and supervisors (MCP servers, coding agents resident + ephemeral, ACP sessions, triggers). Drive it with the single `skelm` CLI: `skelm gateway start --foreground`, `skelm gateway status`, `skelm gateway install --systemd`. See `docs/guides/gateway.md` and `docs/concepts/coding-agents.md`.

## Why skelm

If you have built any of the following with hand-rolled scripts, you have felt skelm-shaped pain:

- A coding assistant reachable on chat that opens PRs in a persistent repo workspace.
- A queue worker that watches Jira and tries to ship the ticket.
- An email-triage agent that classifies, summarizes, and journals decisions you can audit.
- A nightly digest that fans out, enriches with an LLM, and posts to Slack.
- An HTTP endpoint that runs a typed workflow with three deterministic steps and one LLM call.

skelm gives you one substrate for all five.

### Three tenets, in this order

1. **Security.** Default-deny everywhere. Every agent step declares its allowed tools, executables, MCP servers, network egress, and filesystem roots. A backend that cannot enforce a declared permission fails at step start instead of bypassing it. The gateway is the single trust boundary; nothing privileged happens outside it.
2. **Maintenance.** A small core, a narrow public surface, no DSL. Workflows are TypeScript modules — refactor them, test them, version them like any other code.
3. **Robustness.** Typed context end-to-end. Explicit error semantics. Deterministic event log. Durable wait/resume. Persistent state and per-agent workspaces that survive restarts.

These outrank everything else. We will ship a smaller framework that is secure, maintainable, and robust before we ship a larger one that is not.

## A taste

```ts
import { pipeline, code, agent } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'triage-issue',
  description: 'Classify an inbound GitHub issue and label it.',
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
      agentDef: './agents/triager',          // role + soul defined in markdown
      skills:  ['github-readonly'],          // capability bundle
      mcp:     [{ id: 'gh', transport: 'stdio', command: 'mcp-github' }],
      permissions: {
        allowedTools:       ['gh.add_label'],
        allowedMcpServers:  ['gh'],
        allowedSkills:      ['github-readonly'],
        networkEgress:      { allowHosts: ['api.github.com'] },
        fsRead:             ['./'],
        fsWrite:            [],
      },
      prompt: (ctx) => `Triage this issue:\n${JSON.stringify(ctx.steps.fetch)}`,
      output: z.object({ label: z.enum(['bug','feature','duplicate']), reasoning: z.string() }),
      maxTurns: 8,
    }),
  ],
})
```

```sh
# Run it once, right now
skelm run workflows/triage-issue.workflow.ts --input '{"repo":"acme/x","issueNumber":42}'

# Or schedule it via webhook
skelm schedule add workflows/triage-issue.workflow.ts --webhook /webhooks/issue-events

# Stand up the long-running gateway
skelm gateway start
```

## What you get

- **Workflows in TypeScript.** Real types, real composition, real testability. No DSL, no markdown YAML, no visual editor.
- **Three step kinds.** `code()` for deterministic logic, `llm()` for one-shot inference, `agent()` for full agent loops. None is a wrapper around another.
- **Native control flow.** `parallel`, `forEach`, `branch`, `loop`, `wait`, and nested `pipelineStep` are core, not plugins.
- **Multi-backend agent runtime.** Support for multiple agent backends:
  - **Model providers (LLM endpoints):** OpenAI, Anthropic, vllm, sglang, ollama, Google Gemini for direct `llm()` inference
  - **Agent providers (coding agent SDKs):** Opencode (full permission enforcement), ACP backends (Copilot, Claude Code, Gemini CLI), GitHub Copilot SDK (in development)
  - **Future:** Pi coding-agent, custom providers via ModelProvider/AgentProvider SPI
  - **See:** [`docs/backends/README.md`](./docs/backends/README.md) for provider architecture and configuration
- **Scheduler-native.** Every run is a schedule — immediate, one-time, or recurring (cron / interval / webhook / poll / queue). One observability surface for ad-hoc and continuous runs.
- **Per-agent workspaces.** Each agent step gets its own filesystem root, persistent across runs or ephemeral per run. Locked to prevent corruption when concurrent runs target the same workspace.
- **Persistent state and decision journals.** `ctx.state` for typed KV across runs. Append-only journals for "what did the agent decide and why." Idempotency primitives that make 24/7 workflows trivially correct.
- **Default-deny permissions.** `AgentPermissions` is part of the API. Allowed tools, executables, MCP servers, skills, network egress, fs roots — all default to deny.
- **Tamper-evident audit log.** Single-writer, hash-chained, separate from run history. The artifact a compliance review reads.
- **Local-first, self-hosted.** SQLite by default. No managed cloud, no marketplace, no required external dependencies. Postgres + vault drivers for production scale.
- **Long-running gateway service.** Hosts workflows over HTTP + SSE, drives the scheduler, owns the trust boundary. Installable as a systemd user unit with one command.
- **Agent definitions in markdown.** `AGENTS.md` for role, optional `SOUL.md` for persona, `SKILL.md` for capability packages. Reviewable in PRs, versioned in git, separate from environment-specific permissions.
- **Open source, MIT.** Apache 2.0 might be the only license that does less. We picked MIT.

## Install

```sh
npm i -g skelm
skelm init my-bot && cd my-bot
skelm run workflows/hello.workflow.ts
```

`skelm init` scaffolds a working project with one example workflow, an `AGENTS.md` agent definition, a `SKILL.md` skill package, and a `skelm.config.ts` with sensible default-deny permissions.

## Documentation

Customer-facing technical docs live under [`docs/`](./docs/) (a hands-on quickstart, full CLI/API/HTTP reference, deployment guides, and recipes for the common workflow shapes).

- **Provider architecture:** [`docs/backends/README.md`](./docs/backends/README.md) — ModelProvider and AgentProvider abstractions, configuration, and custom provider implementation
- **Quickstart:** [`docs/quickstart/index.md`](./docs/quickstart/index.md) — install, write a workflow, run it
- **Guides:** [`docs/guides/`](./docs/guides/) — testing workflows, writing plugins/backends, authoring tips
- **Recipes:** [`docs/recipes/`](./docs/recipes/) — complete workflow examples
- **Reference:** [`docs/reference/`](./docs/reference/) — API, CLI, HTTP, configuration schemas
- **Deployment:** [`docs/deployment/`](./docs/deployment/) — systemd, reverse proxy, Postgres, secrets

- [`AGENTS.md`](./AGENTS.md) — guidance for contributors and AI coding assistants working on skelm itself.
- [`CLAUDE.md`](./CLAUDE.md) — Claude-specific operating notes for working in this repo.

## Status and roadmap

Roadmap milestones land in this order:

- **M1 — Core runtime + CLI.** Workflow authoring, three step kinds, three in-tree backends (copilot-acp, openai, anthropic), full permission enforcement, SQLite run store.
- **M2 — Control flow + workspaces + state.** parallel/forEach/branch/loop/wait, per-agent workspaces, persistent KV state, agent definition markdown loader, introspection commands.
- **M3 — Gateway, audit, scheduler, debug.** Long-running gateway service, HTTP + SSE, audit log, secrets driver, scheduler with cron/interval/webhook/poll/queue triggers, systemd user unit installer, debug breakpoints.
- **M4 — Integrations + multi-backend support + Postgres.** Curated `@skelm/integrations`, OAuth setup, OpenAI-compatible HTTP surface, **new agent backends** (`@skelm/opencode`, `@skelm/copilot-sdk`, `@skelm/pi`), cost/quality routing wrappers, Postgres run store, vault secrets, distributed dedupe.

See `docs/about/changelog.md` once it lands; the changelog is generated from changesets that ship with every PR.

## Contributing

skelm is built in the open. Contributions are welcome — bug reports, design feedback, documentation fixes, and code.

- Read [`AGENTS.md`](./AGENTS.md) for the contributor workflow, code style, testing expectations, and quality gates.
- Open an issue before sending a large PR so we can align on direction.
- Every PR runs the same `pnpm check` gate locally that CI runs server-side: build, typecheck, lint, unit tests, architectural-invariant guards, security-tenet adversarial fixtures, backend-contract suite, doc-link verification.

The framework dogfoods itself: skelm's own pre-merge review and unit-test generation run as skelm workflows under [`pipelines/internal/`](./pipelines/internal/). Reading those is a good way to learn the API and see how the security tenet works in practice.

## Author

Scott Glover — `scottgl@gmail.com`

## License

MIT. See [LICENSE](./LICENSE). Copyright © Scott Glover.

If you build something interesting on skelm, we want to hear about it — open an issue with the `showcase` label.
