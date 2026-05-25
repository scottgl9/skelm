import { createSkelmAgentBackend } from '@skelm/agent'
import { defineConfig } from 'skelm'

// The gateway resolves backends from the config it is *started* with, so run
// the gateway from this directory (`cd builder && skelm gateway start`) to make
// the local-LLM backend below the one the builder run uses.
export default defineConfig({
  entrypoint: './builder.workflow.mts',
  backends: { agent: 'agent', llm: 'agent' },
  instances: [
    createSkelmAgentBackend({
      id: 'agent',
      baseUrl: process.env.OPENAI_BASE_URL ?? 'http://localhost:8000/v1',
      apiKey: process.env.OPENAI_API_KEY ?? 'unused',
      model: process.env.OPENAI_MODEL ?? 'qwen2.5-coder',
      // Local servers often default to unbounded output; cap for predictable latency.
      maxTokens: 4096,
    }),
  ],
})
