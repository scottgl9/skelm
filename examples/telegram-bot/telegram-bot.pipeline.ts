import { agent, pipeline } from '@skelm/core'
import { z } from 'zod'

/**
 * Telegram-bot pipeline: takes an inbound message, generates a reply via the
 * pi backend, returns the reply text.
 *
 * The pipeline declares a queue trigger bound to the `telegram` source
 * configured in `skelm.config.ts`. The gateway drives the long-poll loop,
 * runs this pipeline per inbound text message, and posts the reply back to
 * the chat via the trigger source's `onResult` hook — keeping I/O out of
 * the pipeline.
 */

export const TelegramInputSchema = z.object({
  updateId: z.number(),
  messageId: z.number(),
  chatId: z.string(),
  from: z.string(),
  text: z.string(),
})

export type TelegramInput = z.infer<typeof TelegramInputSchema>

export const TelegramOutputSchema = z.object({
  reply: z.string(),
})

export type TelegramOutput = z.infer<typeof TelegramOutputSchema>

export default pipeline({
  id: 'telegram-bot',
  description: 'Generate a chat reply for an inbound Telegram message via pi.',
  input: TelegramInputSchema,
  output: TelegramOutputSchema,
  triggers: [{ kind: 'queue', sourceId: 'telegram' }],
  steps: [
    agent({
      id: 'reply',
      backend: 'pi',
      system:
        'You are a helpful assistant chatting on Telegram. Answer in plain text, ' +
        'no Markdown. Keep replies under 400 characters.',
      prompt: (ctx) => {
        const input = ctx.input as TelegramInput
        return `User ${input.from} says: ${input.text}\n\nReply briefly.`
      },
      maxTurns: 4,
      timeoutMs: 120_000,
    }),
  ],
  finalize: (ctx) => ({
    reply: ((ctx.steps.reply as { text?: string }).text ?? '').trim(),
  }),
})
