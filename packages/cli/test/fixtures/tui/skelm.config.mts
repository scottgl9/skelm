// Inline headless TUI driver (mirrors @skelm/integrations createRemoteTriggerSource)
// so the fixture imports nothing — the test loader resolves bare workspace
// specifiers inconsistently from fixture paths. submit fires the turn and
// resolves with the runId captured from the first run event; the CLI then tails
// /runs/:runId/stream for the reply.
let onMessage: ((p: unknown) => Promise<void>) | null = null
let seq = 0
const pending = new Map<number, (r: { runId: string }) => void>()

const driver = {
  transport: 'tui' as const,
  start(opts: { onMessage: (p: unknown) => Promise<void> }) {
    onMessage = opts.onMessage
    seq = 0
  },
  stop() {
    onMessage = null
  },
  onEvent(payload: unknown, event: unknown) {
    const s = (payload as { seq?: number }).seq
    const runId = (event as { runId?: unknown }).runId
    if (typeof s !== 'number' || typeof runId !== 'string') return
    const resolve = pending.get(s)
    if (resolve === undefined) return
    pending.delete(s)
    resolve({ runId })
  },
  async submit(input: { sessionId: string; text: string }): Promise<{ runId: string }> {
    if (onMessage === null) throw new Error('not started')
    seq += 1
    const mySeq = seq
    const result = new Promise<{ runId: string }>((resolve) => pending.set(mySeq, resolve))
    void Promise.resolve(
      onMessage({ sessionId: input.sessionId, from: 'you', text: input.text, seq: mySeq }),
    ).catch(() => {})
    return result
  },
}

export default {
  registries: { workflows: { glob: '*.workflow.mts' } },
  triggerSources: [{ id: 'tui', driver }],
}
