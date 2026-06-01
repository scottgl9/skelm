# chatui-assistant

A **persistent workflow** you talk to from a **terminal _or_ a browser** — one
durable conversation per session that survives across messages and gateway
restarts. It's the [`telegram-assistant`](../telegram-assistant) example driven
over a local chat UI (the `chatui` integration) instead of Telegram, and it's the
minimal persistent-workflow shape: no preamble steps, just the chat agent.

The point of this example: **one integration, one workflow, two frontends.** The
`chatui` integration is transport-neutral — a client POSTs each line to
`/v1/chat/:sourceId/submit`, gets back a `runId`, and tails `/runs/:runId/stream`
for the reply. The `skelm run` terminal host and a browser page are just two
clients of that same contract:

| source id | transport | client | frontend |
|---|---|---|---|
| `tui` | `'tui'` | `skelm run` (this process) | Ink terminal UI (`chatui-frontend.mts`) |
| `web` | `'web'` | a browser | `web-chat.html` (a static page) |

This example also demonstrates:

- **Persistent workflow** (`persistentWorkflow()`) with a per-session
  `agent.sessionKey` and no preamble steps.
- **Agentmemory** wired in for long-term recall across sessions.
- A **file-based persona** via `agent.agentDef: './agents/assistant'` — its
  `AGENTS.md` (instructions) and `SOUL.md` (voice) extend the system prompt.
- The **operator-gated unrestricted bypass** — a freewheeling assistant with full
  shell/network/filesystem access.

## ⚠️ Security — read this first

`chatui-assistant.workflow.mts` sets `permissions.requestUnrestricted: true`, and
`skelm.config.ts` grants it via `defaults.unrestrictedGrants`. **Together these
give the agent full `exec` / network / filesystem access as the gateway user.**

- The **terminal (`tui`)** frontend is local-only — the exposure is whoever can
  type at that terminal.
- The **web** frontend is reachable by **anyone who can hit the gateway**. Keep
  the gateway bound to `127.0.0.1` and do not expose it. The CORS affordance
  below is for *local* development only.

Every bypassed turn writes a `permission.bypassed` entry to
`<stateDir>/audit.jsonl` (`skelm audit query --action permission.bypassed`).
Remove the id from `unrestrictedGrants` and the agent reverts to default-deny.

## Run — terminal (`tui`)

The gateway runs the turns; the terminal chat is hosted by `skelm run`:

```bash
export SKELM_AGENTMEMORY=0          # optional: disable agentmemory
export TUI_SESSION_ID=my-thread     # optional: name the conversation

skelm gateway start --detach        # or leave it running in another terminal
skelm run examples/chatui-assistant/   # activates the project, then opens the chat
```

Type a message and press Enter; the agent replies and remembers the conversation
(message it again — it has context). Ctrl-C / Ctrl-D ends the chat and
deactivates the workflow (the durable conversation is kept).

## Run — web

Same project, the `web` source. Start the gateway with the dev CORS affordance on
so a static page served from another origin can reach it:

```bash
# Start the gateway with the dev-only CORS affordance (default-OFF).
# `1` reflects the request Origin; or set it to an explicit origin.
SKELM_DEV_CORS=1 skelm gateway start --detach

# Serve the static page (any static server works); open it in a browser.
python3 -m http.server -d examples/chatui-assistant 8080
#   → http://localhost:8080/web-chat.html
```

In the page, confirm the **gateway** URL (`http://127.0.0.1:14738`), pick a
**session** id, and chat. Each line is POSTed to `/v1/chat/web/submit` and the
reply streams back over `/runs/:runId/stream` — `step.partial` deltas render live,
the final reply commits. (Serve `web-chat.html` from the **same origin** as the
gateway and you don't need `SKELM_DEV_CORS` at all.)

## Test the UI on its own

You don't need a gateway or a model to exercise the terminal UI. The bundled
driver wires the same trigger source to an echo handler:

```bash
node examples/chatui-assistant/drive.mts
```

Type lines and watch the input → "thinking…" → reply loop — the fastest way to
iterate on the UI itself.

## How it works

`chatui-frontend.mts` owns the terminal (input prompt + message log) and calls
`io.submit(line)` per message; `web-chat.html` does the equivalent in a browser.
The `chatui` integration turns each submit into a `queue` trigger fire; the
gateway routes it through the
[persistent workflow](../../docs/concepts/persistent-workflows.md) to one agent
turn: load the session for `agent.sessionKey(msg) = msg.sessionId`, run the turn
through the gateway's enforcement, persist the updated conversation, and hand the
reply back over the run stream. See the
[recipe](../../docs/recipes/chatui-persistent-workflow.md) for the full walkthrough.
