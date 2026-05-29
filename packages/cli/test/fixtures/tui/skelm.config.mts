// Inline headless TUI driver (mirrors @skelm/integrations createRemoteTriggerSource)
// so the fixture imports nothing — the test loader resolves bare workspace
// specifiers inconsistently from fixture paths. The real example uses the
// published createRemoteTriggerSource(); this is just enough to exercise the
// CLI host + gateway submit route end to end.
let onMessage: ((p: unknown) => Promise<void>) | null = null
let seq = 0
const pending = new Map<number, (r: { reply: string }) => void>()

const driver = {
  transport: 'tui' as const,
  start(opts: { onMessage: (p: unknown) => Promise<void> }) {
    onMessage = opts.onMessage
    seq = 0
  },
  stop() {
    onMessage = null
  },
  onResult(payload: unknown, output: unknown) {
    const s = (payload as { seq?: number }).seq
    if (typeof s !== 'number') return
    const resolve = pending.get(s)
    if (resolve === undefined) return
    pending.delete(s)
    const reply = (output as { reply?: unknown }).reply
    resolve({ reply: typeof reply === 'string' ? reply : '' })
  },
  async submit(input: { sessionId: string; text: string }): Promise<{ reply: string }> {
    if (onMessage === null) throw new Error('not started')
    seq += 1
    const mySeq = seq
    const result = new Promise<{ reply: string }>((resolve) => pending.set(mySeq, resolve))
    await onMessage({ sessionId: input.sessionId, from: 'you', text: input.text, seq: mySeq })
    return result
  },
}

export default {
  registries: { workflows: { glob: '*.workflow.mts' } },
  triggerSources: [{ id: 'tui', driver }],
}
