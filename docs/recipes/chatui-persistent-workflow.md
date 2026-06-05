# Chat-UI persistent workflow (terminal or web)

A chat bot you talk to from a **terminal** or a **browser** — one durable
conversation per session that survives across messages and gateway restarts,
optionally freewheeling with the operator-gated unrestricted bypass. It's the
[Telegram persistent workflow](/recipes/telegram-persistent-workflow) pattern
driven over a local chat UI (the `chatui` integration) instead of Telegram —
handy for local development, an ops box, or any machine where you want a chat
agent without wiring a remote service. It's also the minimal persistent-workflow
shape: no preamble steps, just the chat agent.

**One integration, one workflow, two frontends.** The `chatui` integration is
transport-neutral: a client POSTs each line to `/v1/chat/:sourceId/submit`, gets
a `runId`, and tails `/runs/:runId/stream` for the reply. The `skelm run`
terminal host (`transport: 'tui'`) and a browser page (`transport: 'web'`) are
just two clients of that same contract.

Runnable source: [`examples/chatui-assistant/`](https://github.com/scottgl9/skelm/tree/main/examples/chatui-assistant).

## Project layout

```
chatui-assistant/
├── skelm.config.ts                # tui + web sources + pi backend + agentmemory + grant
├── chatui-assistant.workflow.mts  # the persistent workflow (both triggers)
├── chatui-frontend.mts            # the terminal UI itself (lives here, not in the integration)
├── web-chat.html                  # the browser frontend (a static page)
└── drive.mts                      # standalone UI driver (no gateway, no model)
```

The `@skelm/integrations` `chatui` source is only the **mechanism**: it bridges a
client to the gateway's queue-driver contract. The **terminal UI** lives in this
example (`chatui-frontend.mts`, built on [Ink](https://github.com/vadimdemedes/ink));
the **web UI** is a static page (`web-chat.html`). Either can be swapped without
touching skelm.

## The workflow

```ts
// chatui-assistant.workflow.mts
import { persistentWorkflow } from 'skelm'

export default persistentWorkflow({
  id: 'chatui-assistant',
  // One workflow, two frontends — both sources emit the same input shape.
  triggers: [
    { kind: 'queue', sourceId: 'tui' },
    { kind: 'queue', sourceId: 'web' },
  ],
  agent: {
    backend: 'pi',
    system: 'You are a capable personal assistant chatting in a local chat UI. ...',
    permissions: {
      requestUnrestricted: true,            // inert until the operator grants it
      agentmemory: { allowRecall: true, allowSave: true, allowSearch: true, allowContext: true, allowObserve: true },
    },
    sessionKey: (msg) => msg.sessionId,     // one durable conversation per session
    // No `prompt` override: the default reads `payload.text`.
    reply: (text) => ({ reply: text }),
  },
})
```

No `steps` array — this is the minimal persistent workflow: just the chat
`agent`. The gateway routes each line you type to one enforced *turn* against the
durable conversation rather than a fresh run.

## The config

```ts
// skelm.config.ts (abridged)
import { createRemoteTriggerSource } from '@skelm/integrations'
import { createTerminalFrontend } from './chatui-frontend.mts'

export default defineConfig({
  registries: { workflows: { glob: '*.workflow.{mts,ts}' } },
  instances: [createPiSdkBackend({ id: 'pi', /* ... */ })],
  agentmemory: { enabled: true },         // long-term recall across sessions
  triggerSources: [
    {
      id: 'tui',                          // terminal — hosted by `skelm run`
      driver: createRemoteTriggerSource({
        transport: 'tui',
        frontend: createTerminalFrontend({ banner: 'skelm chatui-assistant' }),
      }),
    },
    {
      id: 'web',                          // browser — `web-chat.html` is the client
      driver: createRemoteTriggerSource({ transport: 'web' }),
    },
  ],
  defaults: {
    // SECURITY: full exec/network/fs bypass for this agent id, as the gateway user.
    unrestrictedGrants: ['chatui-assistant'],
  },
})
```

## Why each piece is here

- **`persistentWorkflow` + `agent.sessionKey`** — the conversation is keyed by
  `sessionId` and persisted in the run store, so it continues across messages and
  restarts. Reuse the same session id to resume a thread after a restart.
- **`agentmemory`** — gives the agent recall beyond the in-session transcript.
  Requires an `@skelm/agentmemory` server; set `SKELM_AGENTMEMORY=0` to skip.
- **`requestUnrestricted` + `unrestrictedGrants`** — the [two-keyed
  bypass](/concepts/permissions#the-unrestricted-bypass-freewheeling-agents).
  The author requests; the operator grants. Neither alone does anything.
- **Two transports, one workflow** — `transport: 'tui'` carries the terminal
  frontend for `skelm run` to render; `transport: 'web'` is headless and a
  browser is the client. Both emit the same `ChatUiMessageInput`.
- **Mechanism vs. UI** — the `chatui` integration supplies only the bridge between
  a client and the gateway. The frontends (`chatui-frontend.mts`, `web-chat.html`)
  are the UI and live with the example, so you can swap either without touching
  skelm.

## Run it — terminal

The gateway runs the turns; `skelm run` hosts the chat in your own terminal:

```bash
export TUI_SESSION_ID=my-thread     # optional: name the conversation
skelm gateway start --detach        # or run it in another terminal
skelm run examples/chatui-assistant/   # activates the project, then opens the chat
```

Type a message and press Enter. The agent replies; message it again — it
remembers. Restart the gateway, reuse the same session id, and the thread
survives. Ask for something that needs the shell; because it's granted, it runs
and reports back. Ctrl-C / Ctrl-D ends the chat and deactivates the workflow.

## Run it — web

```bash
# The dev-only CORS affordance (default-OFF) lets a static page reach the gateway.
SKELM_DEV_CORS=1 skelm gateway start --detach
python3 -m http.server -d examples/chatui-assistant 8080   # serve web-chat.html
#   → open http://localhost:8080/web-chat.html
```

The page POSTs each line to `/v1/chat/web/submit` and renders the reply from
`/runs/:runId/stream` — `step.partial` deltas live, the final reply on completion.
Serve the page from the **same origin** as the gateway and `SKELM_DEV_CORS` isn't
needed. The web frontend is reachable by anyone who can hit the gateway — keep it
bound to localhost.

## Test the UI on its own

You don't need a gateway or a model to exercise the terminal UI. The bundled
driver wires the same trigger source to an echo handler:

```bash
node examples/chatui-assistant/drive.mts
```

This is the fastest way to iterate on the input → "thinking…" → reply loop.

## Observability

Every bypassed turn is audited:

```bash
skelm audit query --action permission.bypassed
```

Remove the id from `unrestrictedGrants` and the same privileged request is denied
(`permission.denied`) — default-deny is one config line away.
