# skelm agent backend

The `@skelm/agent` package is the **first-party native agent backend**. It runs
a multi-turn LLM loop against any OpenAI-compatible endpoint, with permissions
enforced **in-process** by skelm's own `TrustEnforcer`.

No dependency on Pi, Opencode, or ACP — the agent loop, the tool surface, and
the permission gating all live inside this package.

## Capabilities

| Capability         | Value                                                    |
| ------------------ | -------------------------------------------------------- |
| `prompt`           | `true` — drives `llm()` steps via single-shot inference  |
| `run`              | `true` — drives `agent()` steps with multi-turn tool use |
| `mcp`              | `true` — unknown tool names fall through to `ctx.mcpHost.invokeTool` |
| `skills`           | `true` — `load_skill` is gated by `allowedSkills`        |
| `toolPermissions`  | `'native'` — every tool calls `TrustEnforcer` before its side effect |
| `streaming`        | `false`                                                  |

## Built-in tools

The backend ships a small fixed tool surface, each gated by the resolved
`AgentPermissions` of the step:

- `exec(cmd, args)` — gated by `allowedExecutables`.
- `fs_read(path)` / `fs_write(path, content)` — gated by `fsRead` / `fsWrite`
  via `normalizePath`.
- `load_skill(skillId)` — gated by `allowedSkills`.
- Anything else — forwarded to MCP tools advertised through `ctx.mcpHost`.

## Registering the backend

`@skelm/agent` is not auto-wired by the CLI. Register it via `instances:` in
`skelm.config.ts`:

```ts
import { defineConfig } from 'skelm'
import { createSkelmAgentBackend } from '@skelm/agent'

export default defineConfig({
  backends: {
    default: 'skelm-agent',
    instances: {
      'skelm-agent': () =>
        createSkelmAgentBackend({
          baseURL: process.env.OPENAI_API_BASE,
          apiKey: { secret: 'OPENAI_KEY' },
          model: 'gpt-4o-mini',
        }),
    },
  },
})
```

## See also

- [Backends overview](./README.md)
- [`@skelm/agent` README](https://github.com/scottgl9/skelm/blob/main/packages/agent/README.md)
- [Permissions reference](../reference/permissions.md)
