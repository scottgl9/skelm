import { code, pipeline } from '@skelm/core'

interface TuiMsg {
  sessionId: string
  text: string
}

// Plain pipeline (no backend) so the TUI host can be tested end to end: a
// submitted line fires the queue trigger, this echoes it, and the reply flows
// back through the remote source's onResult to the CLI.
export default pipeline<TuiMsg, { reply: string }>({
  id: 'tui-echo',
  triggers: [{ kind: 'queue', sourceId: 'tui' }],
  steps: [
    code({
      id: 'echo',
      run: (ctx) => ({ reply: `echo: ${(ctx.input as TuiMsg).text}` }),
    }),
  ],
  finalize: (ctx) => ({ reply: (ctx.steps.echo as { reply: string }).reply }),
})
