# ACP backends

[Agent Client Protocol](https://agentclientprotocol.com) (ACP) backends spawn a subprocess that speaks ACP over stdio. They are the broadest-compatibility option in skelm: any agent that exposes an ACP mode (Copilot, Claude Code, opencode) plugs in with one config block.

> **Status:** stable for development workflows.

## What they're good for

- **Broad compatibility.** Any ACP-compatible agent works.
- **No additional API key.** The agent handles its own authentication (editor login or its own env var).
- **Same agents you use in editors.** No separate SDK to install.

## ⚠ Permission enforcement is advisory

ACP forwards permission metadata to the subprocess. The subprocess decides whether to comply. Skelm cannot intercept individual tool calls and cannot block execution of denied tools.

| Capability         | Advisory ACP backend | Native SDK backend                         |
|--------------------|----------------------|--------------------------------------------|
| Permission enforced| ❌                   | ✅ (`@skelm/opencode`, `@skelm/pi` SDK)    |
| Tool denial logged | At request time only | Per call                                   |
| Audit completeness | Partial              | Full                                       |

For production workflows that depend on default-deny actually blocking, use the opencode or pi SDK backends.

## Configuring ACP backends

The CLI knows two ACP keys directly:

- **`copilot-acp`** — defaults to `command: 'copilot'`, `args: ['--acp']`. Override either field if you need to.
- **`acp`** — generic ACP backend; `command` is required.

```ts
// skelm.config.ts
backends: {
  agent: 'copilot-acp',
  'copilot-acp': {
    command: 'copilot',          // optional; default: 'copilot'
    args:    ['--acp'],          // optional; default: ['--acp']
    cwd:     './workspace',      // optional
  },
  acp: {
    command: 'claude',
    args:    ['--acp'],
  },
}
```

For more than one ACP-flavoured backend in the same project — e.g. one Copilot and one Claude Code — register them via `instances:` so each gets its own id:

```ts
import { defineConfig, createAcpBackend } from 'skelm'

export default defineConfig({
  instances: [
    createAcpBackend({ id: 'copilot-acp',     command: 'copilot', args: ['--acp'] }),
    // Claude Code has no native ACP mode; the @zed-industries/claude-code-acp
    // adapter makes the `claude` CLI speak ACP over stdio.
    createAcpBackend({ id: 'claude-code-acp', command: 'npx', args: ['-y', '@zed-industries/claude-code-acp'] }),
    createAcpBackend({ id: 'opencode-acp',    command: 'opencode', args: ['acp'] }),
  ],
})
```

### Authentication per agent

| Agent                | How it auths                                              |
|----------------------|-----------------------------------------------------------|
| GitHub Copilot       | Editor sign-in or `GH_TOKEN` (depends on copilot version) |
| Claude Code          | `ANTHROPIC_API_KEY` or `claude` editor login              |
| opencode (ACP mode)  | `OPENCODE_API_KEY`                                        |

Skelm doesn't touch any of these — they're consumed by the subprocess.

## Step-level usage

```ts
import { agent, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'review',
  input:  z.object({ pr: z.string() }),
  output: z.object({ verdict: z.string() }),
  steps: [
    agent({
      id: 'reviewer',
      backend: 'copilot-acp',
      prompt: (ctx) => `Review and return JSON {verdict}:\n${ctx.input.pr}`,
      permissions: {
        allowedTools:       [],
        allowedExecutables: [],
        allowedMcpServers:  [],
        allowedSkills:      [],
        fsRead:             ['./'],
        fsWrite:            [],
        networkEgress:      'deny',
      },
      output: z.object({ verdict: z.string() }),
      maxTurns: 4,
    }),
  ],
})
```

By default, ACP runs in strict mode. If a step declares a non-empty permission
policy that skelm cannot enforce for the ACP process, the run fails closed
before the subprocess starts.

Operators may explicitly opt into advisory mode:

```ts
export default defineConfig({
  backends: {
    acp: {
      command: 'my-acp-agent',
      args: ['--acp'],
      permissionMode: 'advisory',
    },
  },
})
```

Advisory mode forwards permissions to the subprocess as metadata and emits
`permission.advisory` run events plus audit entries. It does not silently weaken
security: `permissionMode: 'advisory'` must be present in config, and network
egress still requires the gateway egress proxy for network policies.

## Capabilities

ACP backends declare:

- `prompt: false` — `agent()` only.
- `streaming: true`
- `mcp: true` (advisory only — see above)
- `skills: false`
- `toolPermissions: 'unsupported'` in strict mode
- `toolPermissions: 'advisory'` only when `permissionMode: 'advisory'`

## Troubleshooting

- **"command not found"** — verify the binary is on `$PATH` (`which copilot`, `which claude`, etc.). Use an absolute `command:` path if needed.
- **"Authentication failed"** — log into the agent through its own mechanism; skelm cannot help here.
- **"Timeout waiting for ACP response"** — the subprocess is unresponsive. Check that it works standalone (`claude --acp` then send a prompt manually).
- **"Agent ignored my permission"** — ACP advisory mode does not enforce skelm
  permissions in the subprocess. Remove `permissionMode: 'advisory'` to fail
  closed, or switch to an SDK backend (`@skelm/opencode` or `@skelm/pi` SDK)
  for native enforcement.

## See also

- [Backends overview](./README.md)
- [Agent Client Protocol](https://agentclientprotocol.com)
- [Opencode backend](./opencode.md)
- [Pi backend](./pi.md)
