import { defineWorkflowConfig } from '@skelm/core'
import { TelegramIntegration } from '@skelm/integrations'
import { createPiSdkBackend } from '@skelm/pi'

const token = process.env.TELEGRAM_BOT_TOKEN
if (token === undefined || token === '') {
  console.warn('[telegram-assistant example] TELEGRAM_BOT_TOKEN is not set')
}

// Who-can-talk allowlist. REQUIRED in practice for this example: the agent runs
// unrestricted, so an open channel would let anyone who finds the bot run
// arbitrary commands as the gateway user. Comma-separated chat ids.
const allowedChatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

if (allowedChatIds.length === 0) {
  console.warn(
    '[telegram-assistant example] TELEGRAM_ALLOWED_CHAT_IDS is empty — the unrestricted ' +
      'agent will accept messages from ANY chat. Set it before exposing this bot.',
  )
}

const telegram = new TelegramIntegration({
  id: 'telegram',
  name: 'Telegram',
  enabled: true,
  credentials: { botToken: token ?? '' },
})

await telegram.init()

export default defineWorkflowConfig({
  registries: {
    workflows: { glob: '*.workflow.{mts,ts}' },
  },
  instances: [
    createPiSdkBackend({
      id: 'pi',
      provider: process.env.PI_PROVIDER ?? 'llamacpp',
      model: process.env.PI_MODEL ?? 'qwen36',
      maxConcurrent: 1,
    }),
  ],
  triggerSources: [
    {
      id: 'telegram',
      driver: telegram.createTriggerSource({
        dropPending: true,
        ...(allowedChatIds.length > 0 && { allowedChatIds }),
      }),
    },
  ],
})
