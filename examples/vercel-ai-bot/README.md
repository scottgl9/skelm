# vercel-ai-bot example

Minimal `agent()` pipeline that runs against any Vercel AI SDK model
(`@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.) under skelm's permission policy.

## Run against OpenAI cloud

```bash
export OPENAI_API_KEY=sk-...
pnpm skelm run examples/vercel-ai-bot/greet.pipeline.ts -i '{"name":"world"}'
```

## Run against a local OpenAI-compatible server (vLLM, llama.cpp, sglang, ollama, …)

```bash
export OPENAI_BASE_URL=http://localhost:8000/v1
export OPENAI_API_KEY=unused
export OPENAI_MODEL=qwen36
pnpm skelm run examples/vercel-ai-bot/greet.pipeline.ts -i '{"name":"world"}'
```

## Notes

- The example sets `networkEgress: 'deny'` on the step. That governs **agent
  tool** network access, not the model's HTTP call to your OpenAI-compatible
  endpoint — same convention as `@skelm/core`'s OpenAI/Anthropic backends.
- See `docs/backends/vercel-ai.md` for the full configuration surface.
