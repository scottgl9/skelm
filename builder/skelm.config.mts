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
  defaults: {
    permissionProfiles: {
      // Least-privilege baseline for the builder agent: read the project (to
      // study the skelm skill + existing workflows), write generated files,
      // and shell out to `skelm validate` / `node`. No network beyond the
      // local LLM endpoint, which the backend reaches directly (not via a tool).
      builder: {
        fsRead: ['./'],
        fsWrite: ['./'],
        allowedExecutables: ['skelm', 'node'],
        allowedSkills: ['skelm'],
        networkEgress: 'deny',
      },
    },
  },
})
