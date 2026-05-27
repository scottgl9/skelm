import { agent, pipeline } from '@skelm/core'
import { z } from 'zod'

// Smoke test for the agentmemory integration.
//
// Run a local agentmemory server first (`npx @agentmemory/agentmemory`)
// and enable it in `skelm.config.ts`:
//
//   agentmemory: { enabled: true, url: 'http://localhost:3111' }
//
// Two runs in a row exercise the recall path: the first writes
// observations under hookType 'post_tool_use' / 'task_completed' on
// every tool call and turn; the second smart-searches for relevant
// hits before the model call and prepends them to the system prompt.

export default pipeline({
  id: 'agentmemory-smoke',
  description: 'Exercises the agentmemory observe + smart-search hooks.',
  input: z.object({ task: z.string().min(1) }),
  output: z.object({ result: z.string() }),
  steps: [
    agent({
      id: 'agent-with-memory',
      // The default backend (set in skelm.config.ts) handles the
      // turn; this step only needs agentmemory + minimal exec/fs.
      prompt: (ctx) => (ctx.input as { task: string }).task,
      permissions: {
        agentmemory: {
          allowObserve: true,
          allowSearch: true,
          allowSession: true,
        },
        // Trim the rest to nothing — the model can still reason about
        // the task without filesystem or tool access for this smoke run.
        allowedTools: [],
      },
    }),
  ],
})
