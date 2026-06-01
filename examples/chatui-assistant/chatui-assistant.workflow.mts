import { persistentWorkflow } from '@skelm/core'

/**
 * chatui-assistant: a chat assistant you talk to from a terminal OR a browser.
 *
 * Like the `telegram-assistant` example but driven over a local chat UI (the
 * `chatui` integration) instead of Telegram — one durable conversation per
 * session, surviving across messages and gateway restarts. The same workflow
 * serves two frontends: the `tui` trigger source (terminal, hosted by
 * `skelm run`) and the `web` trigger source (a static browser page). Both POST
 * lines to `/v1/chat/:sourceId/submit` and tail the run stream for the reply, so
 * nothing in the workflow changes between them. This is the minimal PERSISTENT
 * WORKFLOW shape: no preamble steps, just the chat agent (compare
 * `telegram-assistant`, which adds a `code()` preamble).
 *
 * ⚠️  SECURITY: the agent requests the UNRESTRICTED permission bypass — full
 * exec / network / filesystem access as the gateway user. That request is inert
 * until the operator grants this workflow's id in `skelm.config.ts`
 * (`defaults.unrestrictedGrants`). The terminal frontend is local-only; the web
 * frontend is reachable by anyone who can hit the gateway, so gate it
 * accordingly (bind the gateway to localhost; don't expose it). Read the README
 * before granting the bypass.
 */

interface ChatUiMessageInput {
  sessionId: string
  from: string
  text: string
  seq: number
}

export default persistentWorkflow<ChatUiMessageInput>({
  id: 'chatui-assistant',
  description:
    'Freewheeling unrestricted assistant over a local chat UI — terminal or web (operator-gated bypass).',
  // One workflow, two frontends: terminal (`tui`) and browser (`web`). Both
  // sources emit the same ChatUiMessageInput, so the agent config is identical.
  triggers: [
    { kind: 'queue', sourceId: 'tui' },
    { kind: 'queue', sourceId: 'web' },
  ],
  agent: {
    backend: 'pi',
    // The assistant's persona + operating instructions live in
    // agents/assistant/{SOUL,AGENTS}.md, resolved relative to this file. Prefer
    // this over an inline `system` string once a persona grows past a sentence.
    agentDef: './agents/assistant',
    // Requests the full bypass; only takes effect because skelm.config.ts grants
    // 'chatui-assistant'. The agentmemory ops are declared too so this stays a
    // good template even if the grant is removed and default-deny re-applies.
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
    // One durable conversation per chat session.
    sessionKey: (msg) => msg.sessionId,
    // No `prompt` override: the default reads `payload.text`.
    reply: (text) => ({ reply: text }),
  },
})
