# tui-assistant

A **persistent agent** you talk to from your terminal — one durable conversation
per TUI session that survives across messages and gateway restarts. It's the
[`telegram-assistant`](../telegram-assistant) example driven over a local
terminal UI (the `tui` trigger source) instead of Telegram.

This example demonstrates three things together:

- **Persistent agent** (`persistentAgent()`) with a per-session `sessionKey`.
- **Agentmemory** wired in for long-term recall across sessions.
- The **operator-gated unrestricted bypass** — a freewheeling assistant with full
  shell/network/filesystem access.

The `@skelm/integrations` `tui` source is only the **mechanism** — it bridges a UI
frontend to the gateway's queue-driver contract. The **UI itself**
(`tui-frontend.mts`) lives here, built on Node's `readline` so the example needs
no extra dependency; swap it for a richer terminal-UI library and nothing else
changes.

## ⚠️ Security — read this first

`tui-assistant.workflow.mts` sets `permissions.requestUnrestricted: true`, and
`skelm.config.ts` grants it via `defaults.unrestrictedGrants`. **Together these
give the agent full `exec` / network / filesystem access as the gateway user** —
anything it decides to run, runs.

The TUI is **local-only**: it binds to the terminal the gateway runs in, so the
exposure is whoever can type at that terminal (contrast Telegram, where you must
pin an `allowedChatIds` allowlist). Still:

1. **Audit** — every bypassed turn writes a `permission.bypassed` entry to
   `<stateDir>/audit.jsonl` (query with `skelm audit query --action permission.bypassed`).
2. Run it on a machine / container you are willing to expose.

Remove the agent id from `unrestrictedGrants` and the bot reverts to default-deny
(its declared `agentmemory` permissions still apply) — a good way to develop the
persona before granting the bypass.

## Run

Start the gateway **in the foreground** so the TUI can bind to your terminal:

```bash
# Optional: a running @skelm/agentmemory server (default http://localhost:3111)
export SKELM_AGENTMEMORY=0          # set to disable agentmemory
export TUI_SESSION_ID=my-thread     # optional: name the conversation

skelm gateway start                 # foreground; Ctrl-C drains and exits
```

Type a message and press Enter. The agent replies, remembers the conversation
(message it again — it has context), and the thread survives a gateway restart
(reuse the same `TUI_SESSION_ID`). Ask it to do something that needs the shell
(e.g. "what's the disk usage here?") and — because it's granted — it runs the
command and reports back. Remove the grant and the same request is denied
(`permission.denied`).

## Test the UI on its own

You don't need a gateway or a model to exercise the terminal UI. The bundled
driver wires the same trigger source to an echo handler:

```bash
node examples/tui-assistant/drive.mts
```

Type lines and watch the input → "thinking…" → reply loop. This is the fastest
way to iterate on the UI itself.

## How it works

`tui-frontend.mts` owns the terminal (input prompt + message log) and calls
`io.submit(line)` for each message you type. The `tui` integration turns that into
a `queue` trigger fire; the gateway routes it to one enforced
[persistent-agent turn](../../docs/concepts/persistent-agents.md): load the
session for `sessionKey(msg) = msg.sessionId`, run one agent turn through the
gateway's enforcement, persist the updated conversation, and hand the reply back
to the frontend's `render()`. See the
[recipe](../../docs/recipes/tui-persistent-agent.md) for the full walkthrough.
