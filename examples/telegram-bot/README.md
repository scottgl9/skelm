# Telegram bot example

A minimal Telegram chat bot built on skelm + the pi backend.

- Long-polls Telegram's `getUpdates` (no public webhook URL needed).
- Each inbound text message starts one `telegram-bot` pipeline run.
- The pipeline calls the pi backend (default: `qwen36` on `llamacpp`) and the
  reply text is sent back to the originating chat.

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy its token.
2. Make sure `pi` is on your `PATH` and your provider/model is configured.
3. Install workspace deps from the repo root:

   ```sh
   pnpm install
   ```

## Run

```sh
TELEGRAM_BOT_TOKEN=123456:AA... \
  pnpm tsx examples/telegram-bot/run.ts
```

Optional env vars:

| Var            | Default     | Purpose                                |
| -------------- | ----------- | -------------------------------------- |
| `PI_PROVIDER`  | `llamacpp`  | pi provider name                       |
| `PI_MODEL`     | `qwen36`    | pi model id                            |
| `PI_COMMAND`   | `pi`        | path to the `pi` binary                |

Open Telegram, find your bot, send `/start` and then any message. The bot
should reply within a few seconds.

## Files

- `telegram-bot.pipeline.ts` — pure pipeline (input → agent → reply text).
- `run.ts` — standalone long-poll loop that drives the pipeline and sends
  replies via `TelegramIntegration.sendMessage`.

## Notes

- The runner drops any pending updates on startup (`clearPendingUpdates`) so
  it won't reply to messages received while the bot was offline.
- Only `text` messages are handled; photos, voice, callbacks, etc. are
  ignored. Extend the runner if you need them.
- Long-polling only — webhooks require a publicly reachable gateway. The
  `TelegramIntegration` class supports both modes; see its `setupWebhook`
  and `verifyWebhookSecret` methods.
