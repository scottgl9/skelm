# Telegram persistent agent

A chat bot you talk *through* over Telegram: one durable conversation per chat
that survives across messages and gateway restarts, optionally freewheeling with
the operator-gated unrestricted bypass. This is the [persistent
agent](/concepts/persistent-agents) pattern end to end.

Runnable source: [`examples/telegram-assistant/`](https://github.com/scottgl9/skelm/tree/main/examples/telegram-assistant).

## Project layout

```
telegram-assistant/
├── skelm.config.ts          # telegram source + pi backend + agentmemory + grant
└── assistant.workflow.mts   # the persistent agent
```

## The agent

```ts
// assistant.workflow.mts
import { persistentAgent } from 'skelm'

export default persistentAgent({
  id: 'telegram-assistant',
  backend: 'pi',
  system: 'You are a capable personal assistant chatting over Telegram. ...',
  permissions: {
    requestUnrestricted: true,            // inert until the operator grants it
    agentmemory: { allowRecall: true, allowSave: true, allowSearch: true, allowContext: true, allowObserve: true },
  },
  triggers: [{ kind: 'queue', sourceId: 'telegram' }],
  sessionKey: (msg) => msg.chatId,        // one durable conversation per chat
  promptOf: (msg) => msg.text,
  replyOf: (text) => ({ reply: text }),
})
```

No `steps` array: this is a persistent agent, not a pipeline. The gateway routes
each inbound message to one enforced *turn* rather than a fresh run.

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

- **`persistentAgent` + `sessionKey`** — the conversation is keyed by `chatId`
  and persisted in the run store, so it continues across messages and restarts.
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
