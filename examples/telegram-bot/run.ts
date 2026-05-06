/**
 * Standalone Telegram bot runner.
 *
 * Long-polls Telegram's getUpdates, runs the telegram-bot pipeline once per
 * inbound text message, and sends the agent's reply back to the chat.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... pnpm tsx examples/telegram-bot/run.ts
 *
 * Optional env:
 *   PI_PROVIDER  pi provider name (default: llamacpp)
 *   PI_MODEL     pi model id      (default: qwen36)
 *   PI_COMMAND   path to the pi binary (default: pi on $PATH)
 */

import { BackendRegistry, runPipeline } from '@skelm/core'
import { TelegramIntegration } from '@skelm/integrations'
import { createPiBackend } from '@skelm/pi'
import telegramBot, { type TelegramInput } from './telegram-bot.pipeline.js'

interface TelegramRawUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number | string }
    from?: { username?: string; first_name?: string; id?: number }
    text?: string
    date: number
  }
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (token === undefined || token === '') {
    console.error('TELEGRAM_BOT_TOKEN is not set')
    process.exit(1)
  }

  const telegram = new TelegramIntegration({
    id: 'telegram',
    name: 'Telegram',
    enabled: true,
    credentials: { botToken: token },
  })
  await telegram.init()

  const me = await telegram.getMe()
  console.log(`Connected to Telegram as @${me.username ?? me.id}`)

  const pi = createPiBackend({
    id: 'pi',
    ...(process.env.PI_COMMAND !== undefined && { command: process.env.PI_COMMAND }),
    provider: process.env.PI_PROVIDER ?? 'llamacpp',
    model: process.env.PI_MODEL ?? 'qwen36',
    maxConcurrent: 1,
  })
  const backends = new BackendRegistry()
  backends.register(pi)

  const seen = new Set<number>()
  let offset: number | undefined
  let stopping = false

  const stop = () => {
    stopping = true
    console.log('\nShutting down…')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  // Drop any stale updates from before the bot started so we don't reply
  // to messages from a previous session.
  await telegram.clearPendingUpdates()
  console.log('Listening for messages. Press Ctrl-C to stop.')

  while (!stopping) {
    let updates: TelegramRawUpdate[]
    try {
      updates = (await telegram.getUpdates({
        ...(offset !== undefined && { offset }),
        timeoutSeconds: 25,
        allowedUpdates: ['message'],
      })) as TelegramRawUpdate[]
    } catch (err) {
      if (stopping) break
      const msg = err instanceof Error ? err.message : String(err)
      // Telegram returns 409 Conflict for ~30s after a previous getUpdates
      // long-poll is killed. Back off harder than for a generic failure so
      // we stop hammering the API while it sorts itself out.
      const backoff = msg.includes('Conflict') ? 5000 : 1000
      console.error('getUpdates failed:', msg)
      await sleep(backoff)
      continue
    }

    for (const update of updates) {
      offset = update.update_id + 1
      if (seen.has(update.update_id)) continue
      seen.add(update.update_id)

      const msg = update.message
      if (!msg || msg.text === undefined) continue

      const input: TelegramInput = {
        updateId: update.update_id,
        messageId: msg.message_id,
        chatId: String(msg.chat.id),
        from: msg.from?.username ?? msg.from?.first_name ?? 'user',
        text: msg.text,
      }

      console.log(`[${input.from}] ${input.text}`)

      try {
        await telegram.sendChatAction(input.chatId, 'typing')
        const result = await runPipeline(telegramBot, input, { backends })
        if (result.status !== 'completed') {
          throw result.error ?? new Error(`pipeline failed: ${result.status}`)
        }
        const reply = (result.output as { reply: string }).reply
        await telegram.sendMessage({
          chatId: input.chatId,
          text: reply,
          replyToMessageId: input.messageId,
        })
        console.log(`[bot] ${reply}`)
      } catch (err) {
        console.error('handler failed:', err)
        try {
          await telegram.sendMessage({
            chatId: input.chatId,
            text: `Sorry, I hit an error: ${err instanceof Error ? err.message : String(err)}`,
            replyToMessageId: input.messageId,
          })
        } catch {
          // best-effort
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
