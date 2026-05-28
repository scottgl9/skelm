# TUI persistent agent

A chat bot you talk to from your **terminal**: one durable conversation per TUI
session that survives across messages and gateway restarts, optionally
freewheeling with the operator-gated unrestricted bypass. It's the [Telegram
persistent agent](/recipes/telegram-persistent-agent) pattern driven over a local
terminal UI (the `tui` trigger source) instead of Telegram — handy for local
development, an ops box, or any machine where you want a chat agent without
wiring a remote service.

Runnable source: [`examples/tui-assistant/`](https://github.com/scottgl9/skelm/tree/main/examples/tui-assistant).

## Project layout

```
tui-assistant/
├── skelm.config.ts             # tui source + pi backend + agentmemory + grant
├── tui-assistant.workflow.mts  # the persistent agent
├── tui-frontend.mts            # the terminal UI itself (lives here, not in the integration)
└── drive.mts                   # standalone UI driver (no gateway, no model)
```

The `@skelm/integrations` `tui` source is only the **mechanism**: it bridges a UI
frontend to the gateway's queue-driver contract. The **UI implementation** lives
in this example (`tui-frontend.mts`), so it can be built on whatever terminal-UI
library you like — this one uses Node's built-in `readline` to avoid an extra
dependency.

## The agent

```ts
// tui-assistant.workflow.mts
import { persistentAgent } from 'skelm'

export default persistentAgent({
  id: 'tui-assistant',
  backend: 'pi',
  system: 'You are a capable personal assistant chatting in a local terminal. ...',
  permissions: {
    requestUnrestricted: true,            // inert until the operator grants it
    agentmemory: { allowRecall: true, allowSave: true, allowSearch: true, allowContext: true, allowObserve: true },
  },
  triggers: [{ kind: 'queue', sourceId: 'tui' }],
  sessionKey: (msg) => msg.sessionId,     // one durable conversation per session
  promptOf: (msg) => msg.text,
  replyOf: (text) => ({ reply: text }),
})
```

No `steps` array: this is a persistent agent, not a pipeline. The gateway routes
each line you type to one enforced *turn* rather than a fresh run.

## The config

```ts
// skelm.config.ts (abridged)
import { TuiIntegration } from '@skelm/integrations'
import { createTerminalFrontend } from './tui-frontend.mjs'

const tui = new TuiIntegration({ id: 'tui', name: 'Terminal UI', enabled: true, credentials: {} })
await tui.init()

export default defineConfig({
  registries: { workflows: { glob: '*.workflow.{mts,ts}' } },
  instances: [createPiBackend({ id: 'pi', /* ... */ })],
  agentmemory: { enabled: true },         // long-term recall across sessions
  triggerSources: [{
    id: 'tui',
    driver: tui.createTriggerSource({
      frontend: createTerminalFrontend({ banner: 'skelm tui-assistant' }),
      sessionId: process.env.TUI_SESSION_ID ?? 'tui',
    }),
  }],
  defaults: {
    // SECURITY: full exec/network/fs bypass for this agent id, as the gateway user.
    unrestrictedGrants: ['tui-assistant'],
  },
})
```

## Why each piece is here

- **`persistentAgent` + `sessionKey`** — the conversation is keyed by `sessionId`
  and persisted in the run store, so it continues across messages and restarts.
  Reuse the same `TUI_SESSION_ID` to resume a thread after a restart.
- **`agentmemory`** — gives the agent recall beyond the in-session transcript.
  Requires an `@skelm/agentmemory` server; set `SKELM_AGENTMEMORY=0` to skip.
- **`requestUnrestricted` + `unrestrictedGrants`** — the [two-keyed
  bypass](/concepts/permissions#the-unrestricted-bypass-freewheeling-agents).
  The author requests; the operator grants. Neither alone does anything.
- **The TUI is local-only** — it binds to the terminal the gateway runs in, so
  the exposure is whoever can type at that terminal. Unlike Telegram there is no
  who-can-talk allowlist to set, because there is no remote channel to gate.
- **Mechanism vs. UI** — the `tui` integration supplies only the bridge between a
  frontend and the gateway. The frontend (`tui-frontend.mts`) is the UI and lives
  with the example, so you can replace `readline` with a richer terminal-UI
  library without touching skelm.

## Run it

Start the gateway **in the foreground** so the TUI can bind to your terminal:

```bash
export TUI_SESSION_ID=my-thread     # optional: name the conversation
skelm gateway start
```

Type a message and press Enter. The agent replies; message it again — it
remembers. Restart the gateway, reuse the same `TUI_SESSION_ID`, and the thread
survives. Ask for something that needs the shell; because it's granted, it runs
and reports back.

## Test the UI on its own

You don't need a gateway or a model to exercise the terminal UI. The bundled
driver wires the same trigger source to an echo handler:

```bash
node examples/tui-assistant/drive.mts
```

This is the fastest way to iterate on the input → "thinking…" → reply loop.

## Observability

Every bypassed turn is audited:

```bash
skelm audit query --action permission.bypassed
```

Remove the id from `unrestrictedGrants` and the same privileged request is denied
(`permission.denied`) — default-deny is one config line away.
