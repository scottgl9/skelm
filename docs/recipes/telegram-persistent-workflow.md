# Telegram persistent workflow

A chat bot you talk *through* over Telegram: one durable conversation per chat
that survives across messages and gateway restarts, optionally freewheeling with
the operator-gated unrestricted bypass. This is the [persistent
workflow](/concepts/persistent-workflows) pattern end to end.

Runnable source: [`examples/telegram-assistant/`](https://github.com/scottgl9/skelm/tree/main/examples/telegram-assistant).

## Project layout

```
telegram-assistant/
├── skelm.config.ts          # telegram source + pi backend + agentmemory + grant
└── assistant.workflow.mts   # the persistent workflow
```

## The workflow

```ts
// assistant.workflow.mts
import { code, persistentWorkflow } from 'skelm'

export default persistentWorkflow({
  id: 'telegram-assistant',
  triggers: [{ kind: 'queue', sourceId: 'telegram' }],
  // Preamble: runs fresh each fire. Here it prefixes the sender's name; a real
  // assistant might fetch context, classify intent, or redact secrets here.
  steps: [
    code({ id: 'prepare', run: (ctx) => ({ text: `[${ctx.input.from}] ${ctx.input.text}` }) }),
  ],
  agent: {
    backend: 'pi',
    system: 'You are a capable personal assistant chatting over Telegram. ...',
    permissions: {
      requestUnrestricted: true,            // inert until the operator grants it
      agentmemory: { allowRecall: true, allowSave: true, allowSearch: true, allowContext: true, allowObserve: true },
    },
    sessionKey: (msg) => msg.chatId,        // one durable conversation per chat
    prompt: (ctx) => ctx.steps.prepare.text, // the enriched message
    reply: (text) => ({ reply: text }),
  },
})
```

The terminal `agent` is the persistent part: the gateway routes each inbound
message through the preamble and then to one enforced *turn* against the durable
conversation, rather than a fresh stateless run. The preamble runs fresh each
fire and feeds the turn via `ctx.steps`.

## The config

```ts
// skelm.config.ts (abridged)
export default defineConfig({
  registries: { workflows: { glob: '*.workflow.{mts,ts}' } },
  instances: [createPiBackend({ id: 'pi', /* ... */ })],
  agentmemory: { enabled: true },         // long-term recall across sessions
  triggerSources: [{
    id: 'telegram',
    driver: telegram.createTriggerSource({
      dropPending: true,
      allowedChatIds: ['<your-chat-id>'], // who-can-talk allowlist
    }),
  }],
  defaults: {
    // SECURITY: full exec/network/fs bypass for this agent id, as the gateway user.
    unrestrictedGrants: ['telegram-assistant'],
  },
})
```

## Why each piece is here

- **`persistentWorkflow` + `agent.sessionKey`** — the conversation is keyed by
  `chatId` and persisted in the run store, so it continues across messages and
  restarts. The `code()` preamble enriches each message before the turn.
- **`agentmemory`** — gives the agent recall beyond the in-session transcript.
  Requires an `@skelm/agentmemory` server; set `SKELM_AGENTMEMORY=0` to skip.
- **`requestUnrestricted` + `unrestrictedGrants`** — the [two-keyed
  bypass](/concepts/permissions#the-unrestricted-bypass-freewheeling-agents).
  The author requests; the operator grants. Neither alone does anything.
- **`allowedChatIds`** — the [who-can-talk allowlist](/guides/triggers#who-can-talk-allowlist).
  Mandatory in practice for an unrestricted bot: it is the difference between
  "my assistant" and "a shell for anyone who finds the bot."

## Run it

```bash
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_ALLOWED_CHAT_IDS=<your-chat-id>
skelm gateway start
```

Message the bot, then message again — it remembers. Restart the gateway and
message once more — the thread survives. Ask for something that needs the shell;
because it's granted, it runs and reports back.

## Observability

Every bypassed turn is audited:

```bash
skelm audit query --action permission.bypassed
```

Remove the id from `unrestrictedGrants` and the same privileged request is denied
(`permission.denied`) — default-deny is one config line away.
