# @skelm/codex

> OpenAI Codex backend for [skelm](https://github.com/scottgl9/skelm) — wraps the official [`@openai/codex-sdk`](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) with full skelm permission enforcement, MCP injection, skill loading, and streaming.

[![npm](https://img.shields.io/npm/v/@skelm/codex)](https://www.npmjs.com/package/@skelm/codex)

Part of [skelm](https://github.com/scottgl9/skelm).

Codex authenticates via the host `codex` CLI (`codex login`) or the `CODEX_API_KEY` env var. The SDK spawns codex under the hood and exchanges JSONL events — skelm enforces permissions at the boundary, pins the workspace, optionally routes egress through the gateway's CONNECT proxy, and emits audit events as Codex completes commands, file changes, and MCP tool calls.

| Capability         | Value                                                          |
|--------------------|----------------------------------------------------------------|
| `prompt`           | `false` (codex-sdk is agent-loop only)                         |
| `streaming`        | `true` (`agent_message` text deltas flow to `onPartial`)       |
| `sessionLifecycle` | `true` (`request.sessionId` → `Codex.resumeThread`)            |
| `mcp`              | `true` (skelm MCP servers injected via `config.mcp_servers`)   |
| `skills`           | `true` (skill bodies concatenated into the system prompt)      |
| `toolPermissions`  | `'wrapped'` (Codex enforces sandbox; skelm enforces boundary)  |

## Prerequisites

- `codex` CLI on PATH (`codex --version` ≥ 0.130.0)
- Authenticated session — `codex login` once, or `CODEX_API_KEY` in env

## Install

```bash
npm install @skelm/codex
```

## Quick start

```ts
// skelm.config.ts
import { defineConfig } from 'skelm'

export default defineConfig({
  backends: {
    agent: 'codex',
    codex: {
      model: 'gpt-5.3-codex',
      modelReasoningEffort: 'medium',
      skipGitRepoCheck: true,
    },
  },
  defaults: {
    permissions: {
      networkEgress: 'deny',
      allowedTools: [],
      allowedExecutables: [],
      allowedSkills: [],
      allowedMcpServers: [],
      fsRead: [],
      fsWrite: [],
    },
  },
})
```

```ts
// codex-smoke.pipeline.ts
import { agent, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'codex-smoke',
  input:  z.object({ task: z.string() }),
  output: z.object({ result: z.string() }),
  steps: [
    agent({
      id: 'work',
      backend: 'codex',
      prompt: (ctx) => (ctx.input as { task: string }).task,
      permissions: {
        // For a real read-write workflow grant fsWrite roots + relevant tools.
        // The mapper refuses fsWrite: ['*'] unless approval policy is empty.
        fsRead: [],
        fsWrite: [],
        networkEgress: 'deny',
      },
    }),
  ],
})
```

```bash
skelm run codex-smoke.pipeline.ts --input '{"task":"say ok"}'
```

## Permission mapping

The boundary-time mapper translates a resolved skelm policy into Codex SDK options. If the policy can't be honored safely, it throws `CodexPermissionError` before any Codex invocation.

| Skelm policy                                | Codex SDK option                                              |
|---------------------------------------------|---------------------------------------------------------------|
| `fsWrite: []`, `fsRead: []`                 | `sandboxMode: 'read-only'`                                    |
| `fsWrite: [<roots>]`                        | `sandboxMode: 'workspace-write'`, first root → `workingDirectory`, rest → `additionalDirectories` |
| `request.cwd` set                           | overrides `workingDirectory`                                  |
| `fsWrite: ['*']` AND no approval policy     | `sandboxMode: 'danger-full-access'`                           |
| `fsWrite: ['*']` AND approval policy set    | **refused** — never silently escalate                         |
| `networkEgress: 'deny'`                     | `networkAccessEnabled: false`                                 |
| `networkEgress: 'allow'` or `{ allowHosts }` | `networkAccessEnabled: true` (gateway proxy enforces hosts)  |
| `approval.on` covers `tool` / `executable`  | `approvalPolicy: 'untrusted'`                                 |
| anything else                               | `approvalPolicy: 'on-request'`                                |

## MCP, skills, streaming

- **MCP** — `request.mcpServers` is filtered by `policy.allowedMcpServers`, then passed to `Codex({ config: { mcp_servers: { … } } })`. Stdio transports are translated today; HTTP/SSE transports are dropped with `permission.denied` audit so the gap is visible.
- **Skills** — When `request.skills` is set and the policy permits, the backend calls `context.loadSkill(id)` for each id and concatenates the formatted skill blocks into the system prompt.
- **Streaming** — `agent_message.text` deltas flow to `BackendContext.onPartial`. `command_execution`, `file_change`, and `mcp_tool_call` items surface via `onItem` for audit emission.

## API surface

- `createCodexBackend(options?: CodexBackendOptions): SkelmBackend` — the factory.
- `mapPermissionsToCodex({ policy, workingDirectory })` — boundary mapper; throws `CodexPermissionError` on unsafe widening.
- `buildAuditEntry(...)` — hash-chained-audit-ready record of the mapping decision.
- `filterIds(ids, allowlist)` — partition step-requested ids by an allowlist.
- Re-exports: `CodexPermissionError`, types `CodexBackendOptions`, `MappedCodexPolicy`, `CodexPermissionAuditEntry`.

## Live integration test

```bash
codex login
SKELM_CODEX_INTEGRATION=1 pnpm test packages/codex/test/integration.test.ts
```

The skill-injection test registers a `magic-word` skill and asserts the agent surfaces the skill-provided answer — a real end-to-end verification.

## License

MIT
