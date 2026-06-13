import { code, infer, pipeline } from '@skelm/core'
import { z } from 'zod'
import { resolveMemorySystemConfig } from '../config.js'
import { MEMORY_SECRET, WORKFLOW_PERMISSIONS } from '../permissions.js'
import type { MemorySystemDeps, WorkflowOutcome } from '../types.js'
import { runSessionSummary } from '../workflows/session-summary.js'
import { assembleDeps } from './runtime.js'

const InputSchema = z.object({ sessionId: z.string().min(1) })

/**
 * Session summarization runs a real agent turn: the recall and save bracket an
 * `infer()` step that produces the summary. The summary text flows from the
 * infer step into the save step via `ctx.get`, so the deterministic
 * `runSessionSummary` logic is exercised with a summarizer that returns the
 * infer output.
 */
export default pipeline({
  id: 'memory-session-summary',
  description: 'Summarize one session into a durable memory via an agent turn.',
  input: InputSchema,
  output: z.object({ workflow: z.string(), ok: z.boolean() }),
  steps: [
    code({
      id: 'collect',
      secrets: [MEMORY_SECRET],
      permissions: WORKFLOW_PERMISSIONS['session-summary'],
      run: async (ctx) => {
        const { sessionId } = InputSchema.parse(ctx.input)
        const { deps, config } = assembleDeps(ctx, 'session-summary')
        const recall = await deps.memory.recall({
          project: config.project,
          sessionId,
          limit: config.recallLimit,
        })
        return {
          sessionId,
          transcript: recall.hits.map((h) => `${h.title}: ${h.content}`).join('\n'),
          summaryMaxTokens: config.summaryMaxTokens,
        }
      },
    }),
    infer({
      id: 'summarize',
      system: 'Summarize this agent session into durable, reusable facts in under a paragraph.',
      prompt: (ctx) => ctx.get<{ transcript: string }>('collect')?.transcript ?? '',
      maxTokens: (ctx) =>
        ctx.get<{ summaryMaxTokens?: number }>('collect')?.summaryMaxTokens ??
        resolveMemorySystemConfig().summaryMaxTokens,
    }),
    code({
      id: 'save',
      secrets: [MEMORY_SECRET],
      permissions: WORKFLOW_PERMISSIONS['session-summary'],
      run: async (ctx): Promise<WorkflowOutcome> => {
        const { sessionId } = InputSchema.parse(ctx.input)
        const summary = ctx.get<{ text?: string }>('summarize')?.text ?? ''
        const { deps, config } = assembleDeps(ctx, 'session-summary', {
          summarizer: { summarize: async () => summary },
        })
        const withReplay: MemorySystemDeps = deps
        return runSessionSummary(withReplay, config, { sessionId })
      },
    }),
  ],
})
