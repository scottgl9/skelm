# `@skelm/codex` backend

Drives [OpenAI Codex](https://platform.openai.com/docs/guides/codex) through the official [`@openai/codex-sdk`](https://github.com/openai/codex/blob/main/sdk/typescript/README.md). The SDK spawns the `codex` CLI under the hood and exchanges JSONL events over stdio; skelm enforces permissions at the boundary, pins the workspace, optionally routes egress through the gateway's CONNECT proxy, and emits audit events as Codex completes commands, file changes, and MCP tool calls.

## Prerequisites

- The `codex` CLI installed (`codex --version` should report 0.130.0 or newer).
- An authenticated session — either run `codex login` once, or set `CODEX_API_KEY` in the environment skelm spawns Codex from.

Skelm never touches `~/.codex/auth.json` directly; the SDK reads it like any other Codex invocation.

## Install

```bash
npm i @skelm/codex
```

## Configuration

```ts
// skelm.config.ts
import { defineConfig } from 'skelm'

export default defineConfig({
  backends: {
    agent: 'codex',
    codex: {
      model: 'gpt-5.3-codex',                      // optional default model
      modelReasoningEffort: 'medium',              // 'minimal'|'low'|'medium'|'high'|'xhigh'
      // codexPathOverride: '/custom/path/to/codex',
      // baseUrl: 'https://api.example.com',       // for proxied / self-hosted deployments
      // apiKey: { secret: 'CODEX_API_KEY' },      // explicit override of ambient auth
      skipGitRepoCheck: true,                      // default for ephemeral workspaces
      timeoutMs: 300_000,                          // defensive ceiling
    },
  },
})
```

The full type is `CodexBackendOptions` — see [`packages/codex/src/types.ts`](https://github.com/scottgl9/skelm/blob/main/packages/codex/src/types.ts).

## Capabilities

| Capability         | Value      |
|--------------------|------------|
| `prompt`           | `false` (codex-sdk is agent-loop only; route `llm()` steps to a Codex-compatible OpenAI endpoint via `@skelm/agent` instead) |
| `streaming`        | `true` (`agent_message.text` flows to `BackendContext.onPartial`) |
| `sessionLifecycle` | `true` (`request.sessionId` triggers `Codex.resumeThread`) |
| `mcp`              | `true` (skelm MCP servers injected via Codex `config.mcp_servers`) |
| `skills`           | `true` (skill bodies concatenated into the system prompt) |
| `modelSelection`   | `true` when `options.model` is set |
| `toolPermissions`  | `'native'` (Codex enforces sandbox / approval / network in its own process; skelm checks at the boundary before dispatch) |

## Permission mapping

The mapper in `packages/codex/src/permission-mapper.ts` translates a resolved `AgentPermissions` into Codex SDK options. It refuses to widen — if the policy can't be honored safely, it throws `CodexPermissionError` before any Codex invocation.

| Skelm policy                                | Codex SDK                                                    |
|---------------------------------------------|--------------------------------------------------------------|
| `fsWrite: []`, `fsRead: []`                 | `sandboxMode: 'read-only'`                                   |
| `fsWrite: [<roots>]`                        | `sandboxMode: 'workspace-write'`, first root → `workingDirectory`, rest → `additionalDirectories` |
| `request.cwd` set                           | overrides `workingDirectory` (extras stay in `additionalDirectories`) |
| `fsWrite: ['*']` AND no approval policy     | `sandboxMode: 'danger-full-access'`                          |
| `fsWrite: ['*']` AND approval policy set    | **refused** — never silently escalate                        |
| `networkEgress: 'deny'`                     | `networkAccessEnabled: false`                                |
| `networkEgress: 'allow'` (blanket allow)    | `networkAccessEnabled: true`, `webSearchMode: 'live'`, `webSearchEnabled: true` |
| `networkEgress: { allowHosts: [...] }`       | `networkAccessEnabled: true` (the gateway egress proxy enforces hostnames out-of-band for shell egress), but `webSearchMode: 'disabled'` — Codex's built-in `web_search` runs in-process and cannot be host-gated by the proxy. To use web search, declare `networkEgress: 'allow'`. |
| no `approval` policy (`approval === null`)  | `approvalPolicy: 'never'` — see note below                    |
| `approval.on` covers `tool` or `executable` | `approvalPolicy: 'untrusted'`                                |
| any other approval policy                   | `approvalPolicy: 'on-request'`                               |

> **Default approval is `'never'`.** When a step declares no `approval` policy, the backend asks Codex *not* to prompt for every shell command. In automated pipelines there's no operator available to answer prompts; `sandboxMode` + `workingDirectory` + `networkAccessEnabled` are the primary enforcement boundary. Set `permissions.approval: { on: ['executable'] }` (or `['tool']`) on a step to switch into `'untrusted'` mode where Codex escalates every shell command for human approval.

## MCP servers

Codex's `config.toml` supports MCP servers via the `[mcp_servers]` table. The skelm backend takes `request.mcpServers`, filters by `policy.allowedMcpServers`, and passes the resulting entries to the SDK via `Codex({ config: { mcp_servers: { ... } } })`. Only **stdio** transports are translated today — HTTP/SSE MCP servers are dropped with a `permission.denied` audit event so the gap is visible. Users who need remote MCP can configure `~/.codex/config.toml` directly.

## Skills

When the step declares `skills: [...]` and `allowedSkills` permits them, the backend calls `context.loadSkill(id)` for each id. Returned skill bodies are formatted via `@skelm/core`'s `formatSkillBlock` and concatenated into the user prompt as a system-style preamble, so Codex receives the skill instructions before the user message.

## Streaming events

The SDK yields `ThreadEvent`s during `runStreamed`. Skelm consumes them via `consumeStream()`:

| Codex event                                  | Skelm action                                                  |
|----------------------------------------------|---------------------------------------------------------------|
| `thread.started`                             | (no-op; we use the returned `thread.id`)                      |
| `item.completed { item.type: 'agent_message' }` | aggregate into `response.text`; call `onPartial(text)`        |
| `item.completed { item.type: 'command_execution' }` | surface to `onItem`; map to `agent.exec` audit             |
| `item.completed { item.type: 'file_change' }` | surface to `onItem`; map to `agent.file.write` audit          |
| `item.completed { item.type: 'mcp_tool_call' }` | surface to `onItem`; map to `agent.tool.call` audit         |
| `turn.completed`                             | record `usage.inputTokens / outputTokens / reasoningTokens`   |
| `turn.failed`, `error`                       | throw — runner converts to the step's failure event           |

## Security notes

- **Codex enforces its own sandbox in-process.** Skelm's role is the boundary: the mapper validates declared permissions before any Codex call, and `workingDirectory` is always pinned to the step's `WorkspaceHandle.path`.
- **Egress envelope.** When `BackendContext.proxyEnv` is set, skelm merges `HTTP_PROXY` and `SKELM_EGRESS_TOKEN` into the Codex subprocess env so outbound traffic flows through the gateway's CONNECT proxy. With `networkEgress: { allowHosts }`, the proxy enforces the hostnames; Codex just lifts its own block.
- **Per-event audit.** Tool calls / file writes / shell executions surface through `onItem`; the runner's audit writer records them on the hash-chained journal.
- **`danger-full-access` is rare on purpose.** The mapper refuses to elevate unless the workflow author has *explicitly* given both `fsWrite: ['*']` and an empty approval policy.

## Live test

```
npm i @skelm/codex
codex login
SKELM_CODEX_INTEGRATION=1 pnpm --filter @skelm/codex test test/integration.test.ts
```

The skill-injection test in [`packages/codex/test/integration.test.ts`](https://github.com/scottgl9/skelm/blob/main/packages/codex/test/integration.test.ts) registers a `magic-word` skill, wires it through `context.loadSkill`, and asserts the agent surfaces the skill-provided answer — a real end-to-end verification of MCP-style skill plumbing through Codex.

## Out of scope (today)

- `prompt`/`infer` — Codex is agent-loop only. For Codex *models* in `llm()` steps, point `@skelm/agent` at the OpenAI endpoint.
- Web search (`webSearchMode`) — defer to a follow-up.
- Multimodal `local_image` input — defer.
