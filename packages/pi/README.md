# @skelm/pi

> Pi coding-agent backend for [skelm](https://github.com/scottgl9/skelm) — integrates [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) with full permission enforcement.

[![npm](https://img.shields.io/npm/v/@skelm/pi)](https://www.npmjs.com/package/@skelm/pi)

Part of [skelm](https://github.com/scottgl9/skelm).

Two backends are available:

| | `createPiBackend` (RPC) | `createPiSdkBackend` (SDK) |
|---|---|---|
| **How it works** | Spawns `pi --mode rpc` per call | Uses `@mariozechner/pi-coding-agent` SDK directly |
| **Tool enforcement** | Advisory (skelm intercepts after the fact) | Native (pi hard-enforces the allowlist) |
| **System prompt** | Not controllable | Pi's default; `req.system` appended; optional full replace |
| **Peer dependency** | `pi` CLI on `$PATH` | `@mariozechner/pi-coding-agent` installed |

Use the **SDK backend** for new work — it gives you hard tool enforcement and real system prompt control. The RPC backend exists for environments where the SDK peer dependency can't be installed.

## Install

```bash
npm install @skelm/pi
```

**RPC backend** additionally requires the `pi` CLI on `$PATH`:

```bash
npm install -g @mariozechner/pi-coding-agent   # installs the `pi` binary
```

**SDK backend** additionally requires the SDK as a peer dependency:

```bash
npm install @mariozechner/pi-coding-agent
```

## SDK backend (recommended)

```ts
import { agent, pipeline } from 'skelm'
import { createPiSdkBackend } from '@skelm/pi'

const pi = createPiSdkBackend({
  // All options are optional
  cwd: './workspace',          // working directory; defaults to process.cwd()
  timeout: 300_000,            // ms; default 5 min
  maxConcurrent: 4,            // queued beyond this; 0 = unlimited
})

export default pipeline({
  id: 'refactor',
  steps: [
    agent({
      id: 'pi-step',
      backend: pi,
      prompt: 'Refactor the auth module to use async/await throughout.',
      permissions: {
        allowedExecutables: ['bash'],
        fsRead:  ['./src'],
        fsWrite: ['./src'],
      },
    }),
  ],
})
```

### System prompt

By default pi's coding-agent system prompt is kept active. `req.system` and skill blocks are appended after it.

```ts
// append step-level system context to pi's default prompt (default)
agent({ system: 'Follow the project style guide.', ... })

// replace pi's base prompt entirely (use sparingly)
createPiSdkBackend({ systemPrompt: 'You are a TypeScript refactoring specialist.' })
```

### Sandbox defaults

The SDK backend enables predictable sandboxing out of the box:

| Option | Default | Reason |
|---|---|---|
| `noExtensions` | `true` | `.pi/extensions/` can register tools and intercept messages in ways skelm cannot audit |
| `noSkills` | `true` | skelm injects skills itself; loading `.pi/skills/` would cause duplicates |
| `noContextFiles` | `false` | `AGENTS.md` and `.pi/context/` are useful project context |

Opt back in at the backend level:

```ts
createPiSdkBackend({
  noExtensions: false,   // allow project extensions
  noSkills: false,       // also load .pi/skills/ from cwd
  noContextFiles: true,  // suppress cwd context files
})
```

### Permission → tool mapping

`derivePiToolAllowlist(policy)` translates a skelm `ResolvedPolicy` into pi's native tool names:

| skelm permission | pi tools enabled |
|---|---|
| `allowedExecutables` has `bash` or `sh` | `bash` |
| `fsRead.size > 0` | `read`, `grep`, `find`, `ls` |
| `fsWrite.size > 0` | `write`, `edit` (+ read tools) |
| policy `undefined` | no override — pi uses its defaults |
| policy present, nothing granted | `noTools: 'all'` — all built-ins suppressed |

### ⚠ Permission semantics differ from MCP-host backends

The SDK backend trades skelm's per-call MCP enforcement for pi's process-level enforcement. Two consequences worth knowing:

- **`bash` is all-or-nothing.** Pi has a single `bash` tool, not per-binary tools. If `allowedExecutables` contains `bash` or `sh`, the agent can run *any* binary. Per-binary filtering (e.g. allow `git` but not `rm`) is not enforced — pi has no hook for it. With backends that route through `@skelm/core`'s MCP host, `requestedExecutable()` does enforce per-binary at the call site.
- **Filesystem paths are advisory.** `fsRead`/`fsWrite` paths unlock the *category* of filesystem tools, but pi's `read`/`write`/`grep`/`find`/`ls` tools can access anywhere the pi process has filesystem permission. They do not honour skelm's path allowlist.

If you need per-binary or per-path enforcement, use the MCP-host backends (claude-code, opencode) and route privileged operations through MCP servers that skelm can intercept. Use the pi SDK backend when you accept process-level sandboxing — typically when running pi inside an isolated workspace (ephemeral cwd, OS sandbox, container) where pi's full filesystem and shell access is already bounded.

## RPC backend

```ts
import { createPiBackend } from '@skelm/pi'

const pi = createPiBackend({
  command: 'pi',               // path to binary; default: 'pi' on $PATH
  provider: 'anthropic',       // pi provider name; omit for pi's default
  model: 'claude-opus-4-5',    // model id; omit for pi's default
  cwd: './workspace',
  timeout: 300_000,
  maxConcurrent: 4,
})
```

The RPC backend spawns one `pi --mode rpc` process per call and streams the response over the JSONL protocol. Tool enforcement is advisory — skelm maps `AgentPermissions` to pi's permission flags but cannot intercept individual tool calls after dispatch.

## Skills

Both backends support skelm skills. Declare them on the `agent()` step:

```ts
agent({
  id: 'implement',
  backend: pi,
  skills: ['code-review', 'style-guide'],
  prompt: 'Implement the feature.',
})
```

Skills are injected into the system prompt via `formatSkillBlock` (includes the skill's description, compatibility, and allowed-tools metadata before the body).

## Exports

```ts
// RPC backend
export { createPiBackend, PiBackendError, PiBackendAuthenticationError,
         PiBackendRateLimitError, PiBackendTimeoutError } from '@skelm/pi'
export { createPiBackendFromConfig } from '@skelm/pi'
export { PiProvider, createPiProvider } from '@skelm/pi'
export { PiRpcClient } from '@skelm/pi'
export type { PiBackendOptions, PiBackendConfig, PiRpcClientOptions, PiRpcResponse } from '@skelm/pi'

// SDK backend
export { createPiSdkBackend, derivePiToolAllowlist, PiSdkBackendError,
         PiSdkBackendAuthenticationError, PiSdkBackendTimeoutError } from '@skelm/pi'
export { PiSdkClient } from '@skelm/pi'
export type { PiSdkBackendOptions, PiSdkClientOptions, PiSdkResponse } from '@skelm/pi'
```

## Stability

`0.x` — APIs may change between minor versions until v1.

## License

[MIT](LICENSE)
