# Vercel AI SDK backend (`@skelm/vercel-ai`)

Wrap any Vercel AI SDK [`LanguageModel`](https://ai-sdk.dev/) — from `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, OpenAI-compatible local servers, etc. — and run it under skelm's permission policy.

Powers both `llm()` (single-shot inference via `generateText`) and `agent()` (tool-using agent loop via `generateText({ tools, stopWhen })`).

## Install

```bash
pnpm add @skelm/vercel-ai ai @ai-sdk/openai
# or @ai-sdk/anthropic, @ai-sdk/google, etc.
```

## Quickstart

```ts
// skelm.config.ts
import { defineConfig } from '@skelm/core'
import { openai } from '@ai-sdk/openai'
import { createVercelAiBackend } from '@skelm/vercel-ai'

export default defineConfig({
  backends: { agent: 'vercel-ai' },
  instances: [
    createVercelAiBackend({
      id: 'vercel-ai',
      model: openai('gpt-4o-mini'),
    }),
  ],
})
```

The CLI does not construct this backend from a string-keyed `backends:` entry — you must pass a `LanguageModel` instance, so it lives under `instances:` (same pattern as `createPiSdkBackend`).

## Pointing at a local OpenAI-compatible server

```ts
import { createOpenAI } from '@ai-sdk/openai'
const openai = createOpenAI({
  baseURL: 'http://localhost:8000/v1',
  apiKey: 'unused',
})
createVercelAiBackend({ model: openai('qwen36') })
```

Works with vLLM, llama.cpp, sglang, ollama (`/v1`), and the cloud OpenAI endpoint.

## Options

| Option            | Type            | Default        | Description                                                            |
|-------------------|-----------------|----------------|------------------------------------------------------------------------|
| `id`              | `string`        | `'vercel-ai'`  | Backend id used in `agent({ backend })` and `instances:`.              |
| `label`           | `string`        | `'Vercel AI SDK'` | Human-readable label.                                                |
| `model`           | `LanguageModel` | **required**   | A Vercel AI model instance, e.g. `openai('gpt-4o')`.                   |
| `tools`           | `ToolSet`       | `{}`           | Vercel `tool()` records the model can call. Filtered at run() time.    |
| `systemPrompt`    | `string`        | —              | Base system prompt. See "System-prompt assembly" below.                |
| `temperature`     | `number`        | —              | Forwarded to `generateText`.                                           |
| `maxOutputTokens` | `number`        | —              | Hard cap on tokens generated per call.                                 |
| `maxConcurrent`   | `number`        | `4`            | Maximum simultaneous calls per backend instance. `0` = unlimited.      |
| `timeout`         | `number`        | `300_000`      | Per-call timeout in ms.                                                |
| `providerOptions` | `Record<string, Record<string, unknown>>` | — | Forwarded to `generateText`. Useful for disabling reasoning on models that emit it by default — e.g. `{ openai: { reasoningEffort: 'minimal' } }`. |

## Capabilities

| Flag                | Value      | Notes                                                                        |
|---------------------|------------|------------------------------------------------------------------------------|
| `prompt`            | `true`     | `infer()` via `generateText`.                                                |
| `streaming`         | `false`    | Deferred — see Roadmap.                                                      |
| `sessionLifecycle`  | `false`    |                                                                              |
| `mcp`               | `false`    | Deferred — `experimental_createMCPClient` is not yet wired through.          |
| `skills`            | `true`     | Skill bodies appended to the system prompt.                                  |
| `modelSelection`    | `false`    | Model is bound at backend construction.                                      |
| `toolPermissions`   | `'native'` | Tools are filtered by `allowedTools` and each `execute` is re-checked.       |

## Permission mapping

| skelm policy field     | Behavior in `@skelm/vercel-ai`                                                        |
|------------------------|---------------------------------------------------------------------------------------|
| `allowedTools`         | Filters `options.tools` before passing to `generateText`. Undefined → all denied.     |
| `deniedTools`          | Removes tools from the result even if `allowedTools` would permit.                    |
| `networkEgress`        | **Does not gate the model's HTTP call** — same convention as the OpenAI/Anthropic backends. Tools that perform network access are responsible for their own enforcement. |
| `allowedExecutables`, `fsRead`, `fsWrite` | Not interpreted (no built-in tools). User-defined tools must enforce these themselves. |
| `allowedSkills`        | Enforced via `BackendContext.loadSkill`; the backend uses only what it returns.        |
| `allowedSecrets`       | Not auto-injected into user tools in v1. Tools that need secrets must close over them. |

The wrapper also re-checks the policy at every `execute()` call. A tool whose name is no longer in the allowlist returns `{ __skelmDenied: true, tool, reason, dimension }` to the model — the agent loop continues so the model can adapt rather than crash.

## System-prompt assembly

For `agent()` runs the system prompt is built in this order, joined by `\n\n---\n\n`:

1. `options.systemPrompt`
2. `request.agentDef.soul`
3. `request.agentDef.instructions`
4. `request.system`
5. Loaded skill bodies (one per `request.skills` entry that survives policy)

## Reasoning-mode models (gpt-5, qwen3, …)

The backend always returns `result.text` and ignores reasoning content blocks. But on some models all generated tokens go into reasoning unless the provider is told to skip it — so `result.text` comes back empty even though the model produced output. Two ways to handle that:

- Pass `providerOptions` to disable reasoning at the provider, e.g.
  `providerOptions: { openai: { reasoningEffort: 'minimal' } }`.
- Use a non-reasoning model.

This is most visible on `agent()` runs (where the call uses tool-loop framing); plain `llm()` calls are usually fine.

## Caveats and non-goals

- **Streaming is not supported** in v1. Use `@skelm/pi` SDK or `@skelm/opencode` if you need it.
- **MCP servers are not supported.** The capability flag is `false`; a step that declares MCP servers fails at step start.
- **`networkEgress` does not gate the LLM's HTTP call.** It controls tool network access. The model itself reaches its provider directly.
- **User tools do not currently receive the resolved policy or step secrets.** A tool that needs a secret must close over it at backend-construction time. A `definePolicyAwareTool` helper is planned for v2.
- **`experimental_prepareStep` and similar escape hatches are intentionally not exposed.** Allowing them would let user code register tools that bypass the wrapper, breaking the `'native'` enforcement claim.

## See also

- [Backends overview](./README.md)
- [Permissions](../concepts/permissions.md)
- Source: [`packages/vercel-ai`](../../packages/vercel-ai)
