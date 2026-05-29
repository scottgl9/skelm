import { persistentWorkflow } from '@skelm/core'

/**
 * tui-assistant: a chat assistant you talk to from your terminal.
 *
 * Like the `telegram-assistant` example but driven over a local terminal UI
 * (the `tui` trigger source) instead of Telegram — one durable conversation per
 * TUI session, surviving across messages and gateway restarts. This is the
 * minimal PERSISTENT WORKFLOW shape: no preamble steps, just the terminal
 * agent (compare `telegram-assistant`, which adds a `code()` preamble).
 *
 * ⚠️  SECURITY: the terminal agent requests the UNRESTRICTED permission bypass —
 * full exec / network / filesystem access as the gateway user. That request is
 * inert until the operator grants this workflow's id in `skelm.config.ts`
 * (`defaults.unrestrictedGrants`). The TUI is local-only (it binds to your
 * terminal), so the exposure is whoever can type at that terminal. Read the
 * README before granting the bypass.
 */

interface TuiMessageInput {
  sessionId: string
  from: string
  text: string
  seq: number
}

export default persistentWorkflow<TuiMessageInput>({
  id: 'tui-assistant',
  description:
    'Freewheeling unrestricted assistant over a local terminal UI (operator-gated bypass).',
  triggers: [{ kind: 'queue', sourceId: 'tui' }],
  agent: {
    backend: 'pi',
    system: [
      'You are a capable personal assistant chatting in a local terminal.',
      'You have full access to the shell, network, and filesystem of the machine',
      'you run on — use it to actually accomplish what the user asks, then report',
      'back concisely. Answer in plain text (no Markdown). Keep replies short.',
    ].join(' '),
    // Requests the full bypass; only takes effect because skelm.config.ts grants
    // 'tui-assistant'. The agentmemory ops are declared too so this stays a good
    // template even if the grant is removed and default-deny re-applies.
    permissions: {
      requestUnrestricted: true,
      agentmemory: {
        allowObserve: true,
        allowSearch: true,
        allowContext: true,
        allowSave: true,
        allowRecall: true,
      },
    },
    maxTurns: 12,
    // One durable conversation per terminal session.
    sessionKey: (msg) => msg.sessionId,
    // No `prompt` override: the default reads `payload.text`.
    reply: (text) => ({ reply: text }),
  },
})
