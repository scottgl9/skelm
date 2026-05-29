# tui-assistant

A **persistent workflow** you talk to from your terminal — one durable conversation
per TUI session that survives across messages and gateway restarts. It's the
[`telegram-assistant`](../telegram-assistant) example driven over a local
terminal UI (the `tui` trigger source) instead of Telegram. It's also the minimal
persistent-workflow shape: no preamble steps, just the terminal agent.

This example demonstrates these things together:

- **Persistent workflow** (`persistentWorkflow()`) with a per-session
  `agent.sessionKey` and no preamble steps.
- **Agentmemory** wired in for long-term recall across sessions.
- A **file-based persona** via `agent.agentDef: './agents/assistant'` — its
  `AGENTS.md` (instructions) and `SOUL.md` (voice) extend the system prompt instead
  of an inline `system` string.
- The **operator-gated unrestricted bypass** — a freewheeling assistant with full
  shell/network/filesystem access.

The gateway side is the **headless** `createRemoteTriggerSource()` — it runs no
UI; it just turns submitted lines into workflow turns and returns the reply. The
**terminal UI lives in `skelm run`** (the CLI), which activates this project and
then hosts the chat, POSTing each line to the gateway. This split is what lets
the gateway run as a background daemon while you still chat from your own
terminal.

For an *embedded* UI that runs inside a foreground gateway instead, the
`@skelm/integrations` `tui` integration's `createTriggerSource({ frontend })`
takes a UI frontend directly — `tui-frontend.mts` here is one such frontend, built
on [Ink](https://github.com/vadimdemedes/ink), and `drive.mts` exercises it with
no gateway and no model.

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

The gateway runs the turns; the terminal chat is hosted by `skelm run` in your
own process. With a gateway up (foreground or background), point `skelm run` at
this directory:

```bash
# Optional: a running @skelm/agentmemory server (default http://localhost:3111)
export SKELM_AGENTMEMORY=0          # set to disable agentmemory
export TUI_SESSION_ID=my-thread     # optional: name the conversation

skelm gateway start --detach        # or leave it running in another terminal
skelm run examples/tui-assistant/   # activates the project, then opens the chat
```

`skelm run` activates the project on the gateway (registers the headless TUI
source + workflow, arms the trigger), then hosts the chat: each line you type is
sent to the gateway, which runs a turn and returns the reply. Type a message and
press Enter. The agent replies, remembers the conversation (message it again — it
has context), and the thread survives a gateway restart (reuse the same
`TUI_SESSION_ID`). Ask it to do something that needs the shell (e.g. "what's the
disk usage here?") and — because it's granted — it runs the command and reports
back. Ctrl-C / Ctrl-D ends the chat and deactivates the workflow (the durable
conversation is kept).

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
a `queue` trigger fire; the gateway routes it through the
[persistent workflow](../../docs/concepts/persistent-workflows.md) to its terminal
turn: load the session for `agent.sessionKey(msg) = msg.sessionId`, run one agent
turn through the gateway's enforcement, persist the updated conversation, and hand
the reply back to the frontend's `render()`. See the
[recipe](../../docs/recipes/tui-persistent-workflow.md) for the full walkthrough.
