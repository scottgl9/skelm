# telegram-assistant

A **persistent agent** you talk to over Telegram — one durable conversation per
chat that survives across messages and gateway restarts. Contrast with the
sibling [`telegram-bot`](../telegram-bot) example, which runs a fresh, memoryless
pipeline per message.

This example demonstrates three things together:

- **Persistent agent** (`persistentAgent()`) with a per-chat `sessionKey`.
- **Agentmemory** wired in for long-term recall across sessions.
- The **operator-gated unrestricted bypass** — a freewheeling assistant with full
  shell/network/filesystem access.

## ⚠️ Security — read this first

`assistant.workflow.mts` sets `permissions.requestUnrestricted: true`, and
`skelm.config.ts` grants it via `defaults.unrestrictedGrants`. **Together these
give the agent full `exec` / network / filesystem access as the gateway user** —
anything it decides to run, runs.

Mitigations this example ships with, which you should keep:

1. **`TELEGRAM_ALLOWED_CHAT_IDS`** — only listed chats can drive the agent. Leave
   it unset and the gateway warns loudly; an open channel means anyone who finds
   the bot gets a root-ish shell on your machine.
2. **Audit** — every bypassed turn writes a `permission.bypassed` entry to
   `<stateDir>/audit.jsonl` (query with `skelm audit query --action permission.bypassed`).
3. Run it on a machine / container you are willing to expose.

Remove the agent id from `unrestrictedGrants` and the bot reverts to default-deny
(its declared `agentmemory` permissions still apply) — a good way to develop the
persona before granting the bypass.

## Run

```bash
export TELEGRAM_BOT_TOKEN=123456:your-bot-token
export TELEGRAM_ALLOWED_CHAT_IDS=<your-chat-id>   # strongly recommended
# Optional: a running @skelm/agentmemory server (default http://localhost:3111)
export SKELM_AGENTMEMORY=0                          # set to disable agentmemory

skelm gateway start                                 # foreground; Ctrl-C drains
```

Message the bot. It replies, remembers the conversation (message it again — it
has context), and the thread survives a gateway restart. Ask it to do something
that needs the shell (e.g. "what's the disk usage here?") and — because it's
granted — it runs the command and reports back. Remove the grant and the same
request is denied (`permission.denied`).

## How it works

The gateway routes each inbound Telegram message (a `queue` trigger fire) to one
enforced [persistent-agent turn](../../docs/concepts/persistent-agents.md): load
the session for `sessionKey(msg) = msg.chatId`, run one agent turn through the
gateway's enforcement, persist the updated conversation, post the reply. See the
[recipe](../../docs/recipes/telegram-persistent-agent.md) for the full walkthrough.
