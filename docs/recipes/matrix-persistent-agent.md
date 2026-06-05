# Matrix persistent workflow

A chat bot you talk *through* over [Matrix](https://matrix.org): one durable
conversation per room that survives across messages and gateway restarts,
optionally freewheeling with the operator-gated unrestricted bypass. This is the
[persistent workflow](/concepts/persistent-workflows) pattern end to end — the same
shape as the [Telegram persistent workflow](/recipes/telegram-persistent-workflow),
over a different channel.

Runnable source: [`examples/matrix-assistant/`](https://github.com/scottgl9/skelm/tree/main/examples/matrix-assistant).

## Project layout

```
matrix-assistant/
├── skelm.config.ts          # matrix source + pi backend + agentmemory + grant
└── assistant.workflow.mts   # the persistent workflow
```

## The agent

```ts
// assistant.workflow.mts
import { persistentWorkflow } from 'skelm'

export default persistentWorkflow({
  id: 'matrix-assistant',
  triggers: [{ kind: 'queue', sourceId: 'matrix' }],
  agent: {
    backend: 'pi',
    system: 'You are a capable personal assistant chatting over Matrix. ...',
    permissions: {
      requestUnrestricted: true,          // inert until the operator grants it
      agentmemory: { allowRecall: true, allowSave: true, allowSearch: true, allowContext: true, allowObserve: true },
    },
    sessionKey: (msg) => msg.roomId,      // one durable conversation per room
    prompt: (ctx) => (ctx.input as { body: string }).body,
    reply: (text) => ({ reply: text }),
  },
})
```

No preamble `steps` array: this workflow goes straight to one enforced terminal
*turn* rather than running a fresh pipeline per message.

## The config

```ts
// skelm.config.ts (abridged)
const matrix = new MatrixIntegration({
  id: 'matrix',
  name: 'Matrix',
  enabled: true,
  credentials: {
    homeserverUrl: process.env.MATRIX_HOMESERVER_URL ?? '',
    accessToken: process.env.MATRIX_ACCESS_TOKEN ?? '',
    userId: process.env.MATRIX_USER_ID ?? '',   // the bot's own @user:server
  },
})
await matrix.init()

export default defineConfig({
  registries: { workflows: { glob: '*.workflow.{mts,ts}' } },
  instances: [createPiSdkBackend({ id: 'pi', /* ... */ })],
  agentmemory: { enabled: true },         // long-term recall across sessions
  triggerSources: [{
    id: 'matrix',
    driver: matrix.createTriggerSource({
      dropPending: true,
      allowedRoomIds: ['<!your-room:server>'], // who-can-talk allowlist
    }),
  }],
  defaults: {
    // SECURITY: full exec/network/fs bypass for this agent id, as the gateway user.
    unrestrictedGrants: ['matrix-assistant'],
  },
})
```

## Why each piece is here

- **`persistentWorkflow` + `agent.sessionKey`** — the conversation is keyed by `roomId`
  and persisted in the run store, so it continues across messages and restarts.
- **`agentmemory`** — gives the agent recall beyond the in-session transcript.
  Requires an `@skelm/agentmemory` server; set `SKELM_AGENTMEMORY=0` to skip.
- **`requestUnrestricted` + `unrestrictedGrants`** — the [two-keyed
  bypass](/concepts/permissions#the-unrestricted-bypass-freewheeling-agents).
  The author requests; the operator grants. Neither alone does anything.
- **`credentials.userId`** — the bot's own user id. Matrix `/sync` echoes the
  bot's own messages back; the trigger source uses this id to drop them so the
  agent never replies to itself. Omit it and it is resolved once via `/whoami`.
- **`allowedRoomIds`** — the [who-can-talk allowlist](/guides/triggers#who-can-talk-allowlist).
  Mandatory in practice for an unrestricted bot: it is the difference between
  "my assistant" and "a shell for anyone who can join the room." Pair with
  `allowedUsers` to also gate by sender.

## Run it

```bash
export MATRIX_HOMESERVER_URL=https://matrix.example.org
export MATRIX_ACCESS_TOKEN=...                 # bot access token
export MATRIX_USER_ID=@assistant:example.org   # the bot's own user id
export MATRIX_ALLOWED_ROOM_IDS=!yourroom:example.org
skelm gateway start
```

Message the bot in the room, then message again — it remembers. Restart the
gateway and message once more — the thread survives. Ask for something that needs
the shell; because it's granted, it runs and reports back.

## Encryption

This integration speaks the raw Client-Server API and handles **unencrypted
rooms only** — `m.room.encrypted` events are skipped. Invite the bot to an
unencrypted room (or disable encryption for the room) so it can read messages.

## Observability

Every bypassed turn is audited:

```bash
skelm audit query --action permission.bypassed
```

Remove the id from `unrestrictedGrants` and the same privileged request is denied
(`permission.denied`) — default-deny is one config line away.
