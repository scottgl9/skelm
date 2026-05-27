import { persistentAgent } from '@skelm/core'

/**
 * telegram-assistant: a freewheeling chat assistant you talk to over Telegram.
 * Unlike the `telegram-bot` example (a memoryless pipeline run per message),
 * this is a PERSISTENT AGENT: one durable conversation per chat, surviving
 * across messages and gateway restarts.
 *
 * ⚠️  SECURITY: this agent requests the UNRESTRICTED permission bypass — full
 * exec / network / filesystem access as the gateway user. That request is inert
 * until the operator grants this agent's id in `skelm.config.ts`
 * (`defaults.unrestrictedGrants`). The config also pins an `allowedChatIds`
 * allowlist so only trusted chats can drive it. Read the README before running.
 */

interface TelegramMessageInput {
  updateId: number
  messageId: number
  chatId: string
  from: string
  text: string
}

export default persistentAgent<TelegramMessageInput>({
  id: 'telegram-assistant',
  description: 'Freewheeling unrestricted assistant over Telegram (operator-gated bypass).',
  backend: 'pi',
  system: [
    'You are a capable personal assistant chatting over Telegram.',
    'You have full access to the shell, network, and filesystem of the machine',
    'you run on — use it to actually accomplish what the user asks, then report',
    'back concisely. Answer in plain text (no Markdown). Keep replies short.',
  ].join(' '),
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
  triggers: [{ kind: 'queue', sourceId: 'telegram' }],
  // One durable conversation per Telegram chat.
  sessionKey: (msg) => msg.chatId,
  promptOf: (msg) => msg.text,
  replyOf: (text) => ({ reply: text }),
})
