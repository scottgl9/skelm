import { code, persistentWorkflow } from '@skelm/core'

/**
 * telegram-assistant: a freewheeling chat assistant you talk to over Telegram.
 * Unlike the `telegram-bot` example (a memoryless pipeline run per message),
 * this is a PERSISTENT WORKFLOW: optional preamble steps run fresh each fire,
 * then the workflow ends in one durable, session-keyed agent turn — one
 * conversation per chat, surviving across messages and gateway restarts.
 *
 * ⚠️  SECURITY: the terminal agent requests the UNRESTRICTED permission bypass —
 * full exec / network / filesystem access as the gateway user. That request is
 * inert until the operator grants this workflow's id in `skelm.config.ts`
 * (`defaults.unrestrictedGrants`). The config also pins an `allowedChatIds`
 * allowlist so only trusted chats can drive it. The preamble `code()` step
 * declares no permissions, so it stays default-deny even under the grant — the
 * bypass applies ONLY to the terminal turn. Read the README before running.
 */

interface TelegramMessageInput {
  updateId: number
  messageId: number
  chatId: string
  from: string
  text: string
}

export default persistentWorkflow<TelegramMessageInput>({
  id: 'telegram-assistant',
  description: 'Freewheeling unrestricted assistant over Telegram (operator-gated bypass).',
  triggers: [{ kind: 'queue', sourceId: 'telegram' }],
  // Preamble: runs fresh each fire (NOT persistent). Here it prefixes the
  // sender's name so the agent always knows who it's talking to. A real
  // assistant might fetch context, classify intent, or redact secrets here.
  steps: [
    code({
      id: 'prepare',
      run: (ctx) => {
        const msg = ctx.input as TelegramMessageInput
        return { text: `[${msg.from}] ${msg.text}` }
      },
    }),
  ],
  agent: {
    backend: 'pi',
    // The assistant's persona + operating instructions live in
    // agents/assistant/{SOUL,AGENTS}.md, resolved relative to this file. Prefer
    // this over an inline `system` string once a persona grows past a sentence.
    agentDef: './agents/assistant',
    // Requests the full bypass; only takes effect because skelm.config.ts grants
    // 'telegram-assistant'. The agentmemory ops are declared too so this stays a
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
    // One durable conversation per Telegram chat.
    sessionKey: (msg) => msg.chatId,
    // The user message handed to the agent is the preamble's enriched text.
    prompt: (ctx) => (ctx.steps.prepare as { text: string }).text,
    reply: (text) => ({ reply: text }),
  },
})
