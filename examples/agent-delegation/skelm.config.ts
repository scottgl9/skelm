import { createSkelmAgentBackend } from '@skelm/agent'
import { defineConfig } from '@skelm/core'

// Multi-agent delegation demo: a `router` agent hands research questions off to
// a `research-specialist` agent via the built-in `delegate` tool. Both are
// ordinary one-agent pipelines discovered by the workflows registry; the
// router's `delegation` allowlist is what authorizes the hand-off.
//
// Point the backend at any OpenAI-compatible chat endpoint:
//   SKELM_AGENT_URL=http://localhost:8000/v1 SKELM_AGENT_MODEL=qwen36 \
//     skelm run router.workflow.mts --input '{"message":"What is a quine?"}'
export default defineConfig({
  registries: {
    workflows: { glob: '*.workflow.{mts,ts}' },
  },
  instances: [
    createSkelmAgentBackend({
      id: 'agent',
      baseUrl: process.env.SKELM_AGENT_URL ?? 'http://localhost:8000/v1',
      model: process.env.SKELM_AGENT_MODEL ?? 'qwen36',
      ...(process.env.SKELM_AGENT_API_KEY !== undefined && {
        apiKey: process.env.SKELM_AGENT_API_KEY,
      }),
    }),
  ],
})
