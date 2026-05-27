import { agent, pipeline } from '@skelm/core'
import { z } from 'zod'

// How to use agentmemory with skelm.
//
// Prerequisites:
//   1. Run the memory server:  npx @agentmemory/agentmemory
//   2. Enable it in skelm.config.ts (see this folder's README) and grant the
//      observe/search/session ops in `defaults.permissions.agentmemory`.
//
// The agentmemory loop is automatic on supported backends: each run opens a
// session, captures the prompt (`user_prompt_submit`), recalls relevant prior
// context (prepended to the system prompt), observes each tool call / turn,
// and closes the session. Run this pipeline TWICE with related prompts — the
// second run's model call carries a `<memory>` block recalled from the first.
//
//   skelm run examples/agentmemory/agentmemory.workflow.mts \
//     --input '{"task":"We use HS256 for signing JWTs. Acknowledge."}'
//   skelm run examples/agentmemory/agentmemory.workflow.mts \
//     --input '{"task":"What algorithm do we use to sign JWTs?"}'

export default pipeline({
  id: 'agentmemory-example',
  description: 'Cross-session recall via the agentmemory integration.',
  input: z.object({ task: z.string().min(1) }),
  output: z.object({ answer: z.string() }),
  steps: [
    agent({
      id: 'remember-and-recall',
      prompt: (ctx) => (ctx.input as { task: string }).task,
      permissions: {
        // Grant the three ops the automatic loop uses. Everything else stays
        // default-deny; omit `agentmemory` entirely to disable memory for a step.
        agentmemory: {
          allowObserve: true,
          allowSearch: true,
          allowSession: true,
        },
        // This example reasons from memory alone — no tools or fs needed.
        allowedTools: [],
      },
    }),
  ],
})
