# @skelm/coding-agent

> Project-agnostic coding-agent **workflow package** for [skelm](https://github.com/scottgl9/skelm), built on the native [`@skelm/agent`](../agent) backend.

Part of [skelm](https://github.com/scottgl9/skelm).

Given a repository path and a task, this workflow:

1. **reads the project's own instructions** — `AGENTS.md` / `CLAUDE.md` / `README.md` / `CONTRIBUTING.md` / `docs/README.md` — and infers the stack and a default validation command when the instructions are incomplete (deterministic, no LLM);
2. **plans a bounded change and edits code** with the agent's file-edit tools, under default-deny permissions scoped to the workspace;
3. **runs focused tests + project validation** through **operator-defined executable profiles** (never arbitrary `exec`);
4. **summarizes the diff** and, only when explicitly opted in, **opens a PR**.

Everything privileged is *declared* — there is no hidden capability. Audit of commands, files, and model-tool actions is owned by the gateway; this package adds no second audit writer.

## Install

```sh
pnpm add @skelm/coding-agent @skelm/agent
```

## Programmatic use

```ts
import { runPipeline, BackendRegistry } from '@skelm/core'
import { createSkelmAgentBackend } from '@skelm/agent'
import { createCodingAgentWorkflow } from '@skelm/coding-agent'

const wf = createCodingAgentWorkflow({
  workspace: '/abs/path/to/repo',
  profile: {
    executableProfiles: ['nodeBuild'],
    prExecutableProfiles: ['gitReadOnly'],
    validationCommands: [['pnpm', 'build'], ['pnpm', 'test']],
    focusedTestCommand: ['pnpm', 'vitest', 'run'],
  },
  budget: { maxToolCalls: 80, maxWallClockMs: 15 * 60_000 },
  maxTurns: 40,
})

const reg = new BackendRegistry()
reg.register(createSkelmAgentBackend({ id: 'agent', baseUrl: '…', budget: { maxToolCalls: 80 } }))

const run = await runPipeline(wf, { task: 'Add a retry option to fetchJson()' }, {
  backends: reg,
  executableProfiles: {
    gitReadOnly: { executables: ['git'] },
    nodeBuild: { executables: ['node', 'pnpm'] },
  },
})
```

## As a workflow package

The package ships a `skelm.package.json` manifest with a default workflow. After installing it into a project:

```sh
skelm package install ./node_modules/@skelm/coding-agent
SKELM_CODING_AGENT_WORKSPACE=/abs/repo skelm run @skelm/coding-agent --input '{"task":"…"}'
```

Entry config is read from environment so the package runs unmodified across projects:

| Variable | Meaning |
|---|---|
| `SKELM_CODING_AGENT_WORKSPACE` | absolute repo path (default: `process.cwd()`) |
| `SKELM_CODING_AGENT_PROFILE` | JSON `ProjectProfile` |
| `SKELM_CODING_AGENT_PR` | `1`/`true` to allow PR opening (default off) |
| `SKELM_CODING_AGENT_BACKEND` | backend id (default `agent`) |

## Project profiles

A `ProjectProfile` captures everything that differs between repositories, so one workflow runs everywhere:

| Field | Meaning |
|---|---|
| `executableProfiles` | named executable profiles used for read/edit/validate work |
| `prExecutableProfiles` | named executable profiles added only when `pr.enabled` is true |
| `allowedExecutables` | explicit basenames, **intersected** with the profile expansion (narrows only) |
| `validationCommands` | argv arrays run after editing (no shell). Inferred from the stack when omitted |
| `focusedTestCommand` | fast-feedback test command run before full validation |
| `branchPrefix` / `baseBranch` | branch policy for PR opening |
| `allowHosts` | hostnames the agent may reach when PR opening is enabled (default: none) |

## Permissions (default-deny, workspace-scoped)

The agent step **declares** its `AgentPermissions`; the gateway intersects them with the project defaults — they are a ceiling, never an escalation:

- `fsRead` / `fsWrite` are scoped to the **workspace path only**. A write outside it (including `..` traversal) is denied by `TrustEnforcer`.
- Executables come **only** from named executable profiles. `executableProfiles` stay active for normal validation work; `prExecutableProfiles` are added only when `pr.enabled` is true. No profile ⇒ no executables at all. There is no arbitrary `exec`.
- `networkEgress` is `'deny'` unless `pr.enabled` is true and the profile provides an explicit host allowlist.
- Delegation, MCP servers, skills, secrets, and agentmemory are all left default-deny.

See [docs/concepts/permissions.md](../../docs/concepts/permissions.md) and [docs/reference/permissions.md](../../docs/reference/permissions.md) (executable profiles).

## Budgets

The native harness `AgentBudget` is a **safety limit**, not a permission — it aborts a run deterministically when a cumulative ceiling (tokens, cost, tool calls, wall-clock) is crossed. Pass it to `createSkelmAgentBackend({ budget })`; the workflow additionally caps `maxTurns` on the step.

## Opening a PR (opt-in, default OFF)

`pr.enabled` defaults to `false`: the workflow never pushes, commits, or opens a PR, declared network egress stays fail-closed even if the profile lists hosts, and `prExecutableProfiles` stay withheld. Even with `pr.enabled: true`, the agent can only do so using the executable profile and network host the profile already grants — turning PRs on never widens permissions.

## Testing

Tests use a scripted stub backend (no real LLM, no repo mutation) and assert against the **real** `TrustEnforcer` on the resolved policy the backend received. See `test/` and the package self-test at `workflows/self-test.workflow.ts`.
