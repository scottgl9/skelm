# Coding-agent workflow package

`@skelm/coding-agent` is a project-agnostic **coding-agent workflow package** built on the native [`@skelm/agent`](../backends/skelm-agent.md) backend. Given a repository path and a task, it reads the project's own instructions, plans a bounded change, edits code, runs validation through operator-defined [executable profiles](./permissions.md#executable-profiles), summarizes the diff, and — only when opted in — opens a PR.

It is shipped as a [workflow package](./workflow-packages.md): a `skelm.package.json` manifest, an entrypoint workflow, a config schema, a README, and a self-test.

## The workflow stages

1. **Read instructions (deterministic `code` step).** Probes `AGENTS.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, and `docs/README.md`, and infers the stack (`node-pnpm`, `node`, `rust`, `go`, `python`, …) plus a default validation command from the manifest files when the instructions don't spell one out. No LLM, no network — the output is a recorded, replayable step value.
2. **Implement + validate (`agent` step).** Runs the native `@skelm/agent` loop. The agent reads files, edits via the file-edit tools, runs focused tests then full validation through the **declared executable profiles**, and fixes failures. Bounded by `maxTurns` and the harness `AgentBudget`.
3. **Summarize (`finalize`).** Returns `{ task, stack, instructionSources, summary, prEnabled }`.

## Usage

### Programmatic

```ts
import { runPipeline, BackendRegistry } from '@skelm/core'
import { createSkelmAgentBackend } from '@skelm/agent'
import { createCodingAgentWorkflow } from '@skelm/coding-agent'

const wf = createCodingAgentWorkflow({
  workspace: '/abs/path/to/repo',                       // absolute; the only fs root granted
  profile: {
    executableProfiles: ['nodeBuild'],                  // referenced by name only
    prExecutableProfiles: ['gitReadOnly'],              // added only when pr.enabled
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
  executableProfiles: {                                 // operator-defined; never by the workflow
    gitReadOnly: { executables: ['git'] },
    nodeBuild: { executables: ['node', 'pnpm'] },
  },
})
```

### As an installed package

```sh
skelm package install ./node_modules/@skelm/coding-agent
SKELM_CODING_AGENT_WORKSPACE=/abs/repo skelm run @skelm/coding-agent --input '{"task":"…"}'
```

The default entrypoint reads its config from environment so the package runs unmodified across projects:

| Variable | Meaning |
|---|---|
| `SKELM_CODING_AGENT_WORKSPACE` | absolute repo path (default: `process.cwd()`) |
| `SKELM_CODING_AGENT_PROFILE` | JSON `ProjectProfile` |
| `SKELM_CODING_AGENT_PR` | `1`/`true` to allow PR opening (default off) |
| `SKELM_CODING_AGENT_BACKEND` | backend id (default `agent`) |

## Project profiles

A `ProjectProfile` captures the per-repo differences:

| Field | Meaning |
|---|---|
| `executableProfiles` | named [executable profiles](./permissions.md#executable-profiles) used for read/edit/validate work |
| `prExecutableProfiles` | named executable profiles added only when `pr.enabled` is true |
| `allowedExecutables` | explicit basenames, **intersected** with the profile expansion (narrows only) |
| `validationCommands` | argv arrays run after editing (no shell). Inferred from the stack when omitted |
| `focusedTestCommand` | fast-feedback test command run before full validation |
| `branchPrefix` / `baseBranch` | branch policy used when PR opening is enabled |
| `allowHosts` | hostnames the agent may reach when PR opening is enabled (default: none) |

## Permissions and executable profiles

The agent step **declares** its `AgentPermissions`; the runtime intersects them with the project defaults, so the declaration is a ceiling that can only narrow:

- `fsRead` / `fsWrite` are scoped to the **workspace path only**. A write outside it — including a `..` traversal — is denied by `TrustEnforcer` (`dimension: 'fs.write'`, reason `path-not-in-allowlist`).
- Executables come **only** from the named executable profiles the profile references and the config defines. `executableProfiles` stay active for read/edit/validate work; `prExecutableProfiles` are added only when `pr.enabled` is true. No profile reference means **no executables at all** (default-deny). There is no arbitrary `exec`; referencing an undefined profile fails before the run starts with `UnknownExecutableProfileError`.
- `networkEgress` is `'deny'` unless `pr.enabled` is true and the profile gives an explicit `allowHosts` list.
- Delegation, MCP servers, skills, secrets, and agentmemory are all left default-deny.

See [permissions](./permissions.md) for the full dimension reference and executable-profile semantics.

## Budgets

The native harness [`AgentBudget`](../backends/skelm-agent.md) is a **safety limit**, not a permission — it never widens anything. It aborts the run deterministically (with a `run.warning` then `AgentBudgetExceededError`) when a cumulative token / cost / tool-call / wall-clock ceiling is crossed. Configure it on the backend instance (`createSkelmAgentBackend({ budget })`); the workflow additionally caps `maxTurns` per step.

## Opening a PR (opt-in, default OFF)

`pr.enabled` defaults to `false`: the workflow never pushes, commits, or opens a PR, the agent prompt explicitly says so, declared network egress remains fail-closed even when the profile lists hosts, and `prExecutableProfiles` stay withheld. Setting `pr.enabled: true` lets the agent commit on a branch and open a PR, **but only using the executable profile and network host the profile already grants** — turning PRs on never widens permissions. The `GITHUB_TOKEN` secret is declared name-only in the manifest and resolved by the gateway only when granted.

## Audit

Command, file, and model-tool actions are audited by the **gateway** through its single audit writer — this package adds none. The agent step's tool dispatch surfaces as the gateway's normal `tool.call` / `tool.result` / `permission.denied` events.

## Determinism in tests

The package's tests inject a **scripted stub backend** (no real LLM, no repo mutation), so they are deterministic in CI. They assert the workflow reads project instructions, scopes `fsWrite` to the workspace, requests only the declared executable profiles, and keeps PR-opening off by default. The security test constructs the **real** `TrustEnforcer` from the exact `ResolvedPolicy` the backend received and proves the agent cannot write outside the workspace or exec outside its profiles. The self-test (`workflows/self-test.workflow.ts`) runs the whole pipeline end-to-end against a tiny fixture repo with the stub.
