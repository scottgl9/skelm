# @skelm/ollama

Local-model backend for skelm. Targets [Ollama](https://ollama.com) by default
but works against any server that speaks the OpenAI `/v1/chat/completions`
wire format — vLLM, LM Studio, llama.cpp's OpenAI-compatible mode, etc.

The point is **keyless evaluation**: contributors, CI, and air-gapped
environments can exercise full agent flows without an API credit card or a
cloud secret.

## Install

```sh
pnpm add @skelm/ollama @skelm/core
ollama pull llama3.2
ollama serve
```

## Use

```ts
import { createOllamaBackend } from '@skelm/ollama'
import { llm, pipeline } from '@skelm/core'

const wf = pipeline({
  id: 'local-summary',
  steps: [
    llm({
      id: 'summarize',
      backend: 'ollama',
      prompt: ({ input }) => `Summarize this in one sentence: ${input}`,
    }),
  ],
})

// Wire the backend in your runner / gateway config:
const backend = createOllamaBackend({ model: 'llama3.2' })
```

## Configuration

| Option       | Default                          | Notes                                    |
| ------------ | -------------------------------- | ---------------------------------------- |
| `baseUrl`    | `http://127.0.0.1:11434/v1`      | Override for vLLM / LM Studio / etc.    |
| `model`      | `llama3.2`                       | Pulled by Ollama on first use            |
| `apiKey`     | `process.env.OLLAMA_API_KEY`     | Most local servers don't need one        |

## Capabilities

| Feature             | Status         | Why                                                  |
| ------------------- | -------------- | ---------------------------------------------------- |
| `prompt` (`infer`)  | yes            |                                                      |
| `streaming`         | no for v1      | Adds noise to the contract; non-streaming first      |
| `sessionLifecycle`  | no             | Wire the agent loop through `agent()` instead        |
| `mcp`               | no             | Local models rarely run MCP servers                  |
| `skills`            | no             |                                                      |
| `modelSelection`    | yes            |                                                      |
| `toolPermissions`   | `unsupported`  | Local-model tool-use is too varied for native enforcement |

If a step asks for a feature this backend doesn't support, the runtime
returns a typed capability error rather than silently degrading.

## Development

```sh
pnpm --filter @skelm/ollama test
```

The unit tests run against an in-process HTTP server; no live Ollama
instance is needed.
