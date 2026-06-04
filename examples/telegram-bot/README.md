# Telegram bot example

A minimal Telegram chat bot built on skelm + the pi backend.

The example shows how to wire a long-running event source — Telegram's
`getUpdates` long-poll — into the gateway as a first-class trigger. The
pipeline declares its own trigger; the gateway runs the loop, dispatches
each message into a workflow run, and posts the agent's reply back to the
chat. There is no script to run — just `skelm gateway start`.

## How it fits together

- `telegram-bot.pipeline.mts` declares
  `triggers: [{ kind: 'queue', sourceId: 'telegram' }]`. That binds the
  pipeline to the trigger source named `telegram` in the config.
- `skelm.config.ts` builds a `TelegramIntegration` with the bot token and
  registers `telegram.createTriggerSource()` under that id.
- On `skelm gateway start`, the gateway:
  1. Loads the config and registers the trigger source as a queue driver.
  2. Discovers the pipeline file via the workflows glob and reads its
     `triggers` field.
  3. Starts the source's long-poll loop. Each inbound text update fires
     the pipeline with the message as input.
  4. After the run completes, the source's `onResult` hook posts
     `output.reply` back to the originating chat.

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy its token.
2. Make sure `pi` is on your `PATH` and your provider/model is configured.
3. Install workspace deps from the repo root:

   ```sh
   pnpm install
   ```

## Run

From `examples/telegram-bot`:

```sh
TELEGRAM_BOT_TOKEN=123456:AA... \
  skelm gateway start --foreground
```

The startup banner reports `triggers: 1` once the queue trigger is registered.

Optional env vars:

| Var            | Default     | Purpose                                |
| -------------- | ----------- | -------------------------------------- |
| `PI_PROVIDER`  | `llamacpp`  | pi provider name                       |
| `PI_MODEL`     | `qwen36`    | pi model id                            |
| `PI_COMMAND`   | `pi`        | path to the `pi` binary                |

Open Telegram, find your bot, send `/start` and then any message. The bot
should reply within a few seconds.

## Files

- `telegram-bot.pipeline.mts` — pure pipeline (input → agent → reply text),
  with a queue trigger declaration bound to the `telegram` source.
- `skelm.config.ts` — registers the pi backend instance and the Telegram
  trigger source, points the workflows glob at the pipeline file.

## Notes

- The trigger source drops any pending updates on startup
  (`dropPending: true`) so it won't reply to messages received while the
  bot was offline. Disable that in `skelm.config.ts` if you want
  catch-up behavior.
- Only `text` messages are handled; non-text updates are skipped by the
  source. Extend `telegramUpdateToInput` (or write a richer extractor) if
  you need them.
- This example uses long polling — no public webhook URL needed. The same
  `TelegramIntegration` class also supports webhook delivery via
  `setupWebhook` and `verifyWebhookSecret`; that path can plug into a
  `webhook` trigger kind instead.
- Sending the reply lives in the trigger source's `onResult` hook, not in
  the pipeline. That keeps the pipeline pure and testable: you can run it
  via `skelm run` against a fixture input without any network I/O.
