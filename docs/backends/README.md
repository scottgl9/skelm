# Backends

A **backend** in skelm is anything that satisfies the `SkelmBackend` interface from `@skelm/core`. The runtime calls `inference()` on the backend for `infer()` steps and `run()` for `agent()` steps; nothing else is special-cased.

There is one interface, one registry. The split between "model" and "agent" is a *capability* the backend declares, not a parallel class hierarchy.

```ts
interface SkelmBackend {
  id: string
  label?: string
  capabilities: BackendCapabilities
  inference?(req: InferenceRequest, ctx: BackendContext): Promise<InferenceResponse>
  run?(req: AgentRequest, ctx: BackendContext): Promise<AgentResponse>
}
```

Capabilities (`prompt`, `streaming`, `mcp`, `skills`, `modelSelection`, `toolPermissions`, `sessionLifecycle`) tell the runtime what the backend can do; the runtime fails closed when a step asks for something the backend doesn't support.

## Built-in backends

| Backend                 | Factory                            | Package          | `infer()` | `agent()` | Tool enforcement |
|-------------------------|------------------------------------|------------------|:-------:|:---------:|------------------|
| OpenAI / OpenAI-compat  | `createOpenAIBackend`              | `@skelm/core`    |   ✅    |    —      | n/a              |
| Anthropic               | `createAnthropicBackend`           | `@skelm/core`    |   ✅    |    —      | n/a              |
| ACP (generic)           | `createAcpBackend`                 | `@skelm/core`    |   —     |    ✅     | advisory         |
| Routing backend         | `createRoutingBackend`             | `@skelm/core`    |   ✅    |    ✅     | delegated        |
| Pi (RPC)                | `createPiBackendFromConfig`        | `@skelm/pi`      |   —     |    ✅     | advisory         |
| Pi (SDK)                | `createPiSdkBackend`               | `@skelm/pi`      |   ✅    |    ✅     | native           |
| Opencode                | `createOpencodeBackendFromConfig`  | `@skelm/opencode`|   —     |    ✅     | native           |
| Vercel AI SDK           | `createVercelAiBackend`            | `@skelm/vercel-ai`|  ✅    |    ✅     | native           |
| skelm agent (in-process)| `createSkelmAgentBackend`          | `@skelm/agent`    |  ✅    |    ✅     | native           |

The CLI (`packages/cli/src/backends.ts`) wires the OpenAI, Anthropic, generic ACP, Copilot ACP, opencode, and pi-RPC backends from `skelm.config.ts` automatically. To use the **pi SDK backend**, the **Vercel AI SDK backend**, the **skelm agent backend**, or any other backend not listed above, register it via `instances:` (see "Registering a custom backend" below).

## Configuring built-in backends from `skelm.config.ts`

The `backends` map keys each entry by id. The CLI reads each entry and calls the matching factory.

```ts
// skelm.config.ts
import { defineConfig } from 'skelm'

export default defineConfig({
  backends: {
    // Selectors
    default: 'openai',     // used by both infer() and agent() if not overridden
    infer:     'openai',     // optional — default for infer() steps
    agent:   'opencode',   // optional — default for agent() steps

    // Backend definitions
    openai: {
      baseUrl: 'https://api.openai.com/v1',  // or any OpenAI-compatible URL
      apiKey:  { secret: 'OPENAI_API_KEY' },
      model:   'gpt-4o-mini',
    },
    anthropic: {
      apiKey: { secret: 'ANTHROPIC_API_KEY' },
      model:  'claude-sonnet-4-6',
    },
    opencode: {
      apiKey: { secret: 'OPENCODE_API_KEY' },
      agent:  'build',
    },
    'copilot-acp': {
      command: 'copilot',
      args:    ['--acp'],
    },
  },
})
```

`{ secret: 'NAME' }` resolves to `process.env.NAME` at gateway start. Plain strings are taken verbatim — useful for local URLs but not for keys.

## Using a backend in a workflow

Step-level `backend:` overrides the config-level default.

```ts
import { agent, infer, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'summarize-and-act',
  input:  z.object({ text: z.string() }),
  output: z.object({ summary: z.string(), action: z.string() }),
  steps: [
    infer({
      id: 'summarize',
      backend: 'openai',
      prompt: (ctx) => `Summarize in one sentence:\n${ctx.input.text}`,
      output: z.object({ summary: z.string() }),
    }),
    agent({
      id: 'decide',
      backend: 'pi',
      prompt: (ctx) => `Given the summary, propose an action and return JSON {action}:\n${ctx.steps.summarize.summary}`,
      permissions: {
        allowedTools: [], allowedExecutables: [], allowedMcpServers: [],
        allowedSkills: [], fsRead: [], fsWrite: [], networkEgress: 'deny',
      },
      output: z.object({ action: z.string() }),
      maxTurns: 4,
    }),
  ],
})
```

## Registering a custom (or unwired) backend

For any backend the CLI doesn't know how to construct from a `backends:` entry — including the **pi SDK backend** — pre-build the instance and pass it via `instances:`. The runtime registers it directly under its `id`.

```ts
import { defineConfig } from 'skelm'
import { createPiSdkBackend } from '@skelm/pi'

export default defineConfig({
  backends: { agent: 'pi' },
  instances: [createPiSdkBackend({ id: 'pi' })],
})
```

The same pattern works for backends you write yourself — see [Writing a backend](../guides/writing-a-backend.md).

## Picking a backend for `infer()`

For `infer()` you almost always want a model provider (`createOpenAIBackend` or `createAnthropicBackend`). The OpenAI backend talks to anything that exposes the OpenAI `/v1/chat/completions` shape — vLLM, llama.cpp, sglang, ollama (with `/v1`), and the cloud OpenAI endpoint all work behind the same factory:

```ts
openai: {
  baseUrl: 'http://localhost:8000/v1',
  apiKey:  'unused-but-required',
  model:   'whatever-your-server-serves',
}
```

`OPENAI_BASE_URL` and `OPENAI_API_KEY` are read as fallbacks when the config omits them.

## Picking a backend for `agent()`

For `agent()` you want a coding-agent backend that can drive multi-turn tool use under skelm's permission model. The recommended choices are:

- **`@skelm/pi` SDK** (`createPiSdkBackend`) — native enforcement of the skelm permission policy; pi resolves the underlying model from its own settings (`~/.pi/auth.json`, `~/.pi/models.json`).
- **`@skelm/opencode`** (`createOpencodeBackendFromConfig`) — native enforcement; reaches the opencode agent service.
- **`@skelm/codex`** (`createCodexBackend`) — OpenAI Codex via the official `@openai/codex-sdk`. Wrapped tool enforcement: Codex enforces its sandbox in-process; skelm validates the policy at the boundary, pins the workspace, and audits per-event. MCP servers are injected via Codex's `config.mcp_servers`, and skill bodies are concatenated into the system prompt.
- **ACP backends** (`createAcpBackend`) — works with any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (Copilot, Claude Code, opencode). Tool enforcement is **advisory** — the subprocess can ignore the allowlist; skelm logs the violation but cannot prevent it.
- **`@skelm/vercel-ai`** (`createVercelAiBackend`) — wrap any Vercel AI SDK model (`@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.) and reuse Vercel `tool({…})` definitions under skelm's permission policy. Tools are filtered by `allowedTools` and each `execute` is re-checked at call time. Streaming and MCP not yet supported.

Per-backend pages cover configuration in detail:
- [pi](./pi.md)
- [opencode](./opencode.md)
- [codex](./codex.md)
- [ACP backends](./acp-backends.md)
- [vercel-ai](./vercel-ai.md)

## Failure model

- **Capability gap.** Step requires a capability (`prompt`, `mcp`, `skills`, native tool enforcement) the backend does not declare → fail at step start with a typed error. The runtime never silently degrades.
- **Permission denial.** Backend with `toolPermissions: 'native'` enforces the resolved policy; backend with `toolPermissions: 'advisory'` reports violations the runtime then audits. Either way the run journals the denial.
- **Transport error.** Backends throw typed errors (`PiSdkBackendError`, `PiSdkBackendTimeoutError`, `AcpProtocolError`, …); the runtime maps them to `step.failed` events.

## See also

- [Writing a backend](../guides/writing-a-backend.md) — how to implement `SkelmBackend` end-to-end
- [Permissions](../concepts/permissions.md) — how permission policy interacts with backend capabilities
- [`packages/core/src/backend.ts`](https://github.com/scottgl9/skelm/blob/main/packages/core/src/backend.ts) — the canonical `SkelmBackend` interface
