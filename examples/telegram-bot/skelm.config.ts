import { defineConfig } from '@skelm/core'
import { TelegramIntegration } from '@skelm/integrations'
import { createPiBackend } from '@skelm/pi'

const token = process.env.TELEGRAM_BOT_TOKEN
if (token === undefined || token === '') {
  // The gateway will still start, but the trigger source will fail to init.
  // Surface the misconfiguration loudly so the operator can fix it.
  console.warn('[telegram-bot example] TELEGRAM_BOT_TOKEN is not set')
}

const telegram = new TelegramIntegration({
  id: 'telegram',
  name: 'Telegram',
  enabled: true,
  credentials: { botToken: token ?? '' },
})

// Initialize eagerly so credentials are validated before the gateway starts
// the long-poll loop. Errors here will surface from `skelm gateway start`.
await telegram.init()

export default defineConfig({
  registries: {
    workflows: { glob: '*.pipeline.{mts,ts}' },
  },
  instances: [
    createPiBackend({
      id: 'pi',
      ...(process.env.PI_COMMAND !== undefined && { command: process.env.PI_COMMAND }),
      provider: process.env.PI_PROVIDER ?? 'llamacpp',
      model: process.env.PI_MODEL ?? 'qwen36',
      maxConcurrent: 1,
    }),
  ],
  triggerSources: [{ id: 'telegram', driver: telegram.createTriggerSource({ dropPending: true }) }],
})
