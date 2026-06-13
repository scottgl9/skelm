import { type Context, code, pipeline } from '@skelm/core'
import type { SubagentInput } from '../src/index.js'

/**
 * Self-test subagent. Deterministic, code-only (no LLM backend) so the fan-out
 * merge is exercised without a model. Reads the `SubagentInput` envelope the
 * recipe threads to every child and echoes back a scored result; an input
 * whose payload contains "fail" throws so failure handling is covered too.
 */
export default pipeline({
  id: 'subagent-orchestrator-selftest-child',
  description: 'Deterministic self-test subagent that scores its input.',
  steps: [
    code({
      id: 'work',
      run: (ctx: Context) => {
        const envelope = ctx.input as SubagentInput<{ text: string; score: number }>
        const payload = envelope.payload
        if (payload === undefined) throw new Error('missing payload')
        if (payload.text.includes('fail')) throw new Error(`subagent rejected: ${payload.text}`)
        return { role: envelope.role, text: payload.text, score: payload.score }
      },
    }),
  ],
})
