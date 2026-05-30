# @skelm/vercel-ai

[Vercel AI SDK](https://ai-sdk.dev/) backend for [skelm](https://github.com/scottgl9/skelm).

Wrap any AI SDK `LanguageModel` (`@ai-sdk/openai`, `@ai-sdk/anthropic`, OpenAI-compatible local servers, …) and run it under skelm's permission policy. Powers both `infer()` and `agent()` step types.

## Install

```bash
pnpm add @skelm/vercel-ai ai @ai-sdk/openai
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
    createVercelAiBackend({ id: 'vercel-ai', model: openai('gpt-4o-mini') }),
  ],
})
```

```ts
// greet.pipeline.mts
import { agent, pipeline } from '@skelm/core'
import { z } from 'zod'

export default pipeline({
  id: 'greet',
  input: z.object({ name: z.string() }),
  output: z.object({ greeting: z.string() }),
  steps: [
    agent({
      id: 'greet',
      backend: 'vercel-ai',
      prompt: (ctx) => `Greet ${ctx.input.name}. Reply JSON {greeting}.`,
      permissions: {
        allowedTools: [], allowedExecutables: [], allowedMcpServers: [],
        allowedSkills: [], fsRead: [], fsWrite: [], networkEgress: 'deny',
      },
      output: z.object({ greeting: z.string() }),
      maxTurns: 1,
    }),
  ],
})
```

## What's enforced

- **Default-deny tools.** A step with no `allowedTools` sees no tools, even if the backend was constructed with a non-empty `tools:` set.
- **Per-tool filtering.** Only tools whose names match `allowedTools` are passed to the model. `deniedTools` removes from the result.
- **Call-time re-check.** Each surviving tool's `execute` is wrapped to re-check the policy before dispatch; denial returns a structured result the model can adapt to.

## What's not

- **Streaming** — deferred.
- **MCP servers** — deferred.
- **`networkEgress`** — does not gate the LLM's own HTTP connection (same convention as the built-in OpenAI/Anthropic backends).

See the [docs page](https://github.com/scottgl9/skelm/blob/main/docs/backends/vercel-ai.md) for details, the full options table, and roadmap.

## License

MIT
