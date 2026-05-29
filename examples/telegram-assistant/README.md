# telegram-assistant

A **persistent workflow** you talk to over Telegram — one durable conversation per
chat that survives across messages and gateway restarts. Contrast with the
sibling [`telegram-bot`](../telegram-bot) example, which runs a fresh, memoryless
pipeline per message.

This example demonstrates these things together:

- **Persistent workflow** (`persistentWorkflow()`) with a `code()` preamble step
  feeding a per-chat session-keyed terminal agent (`agent.sessionKey`).
- **Agentmemory** wired in for long-term recall across sessions.
- A **file-based persona** via `agent.agentDef: './agents/assistant'` — its
  `AGENTS.md` (instructions) and `SOUL.md` (voice) extend the system prompt instead
  of an inline `system` string.
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

skelm gateway start --detach                        # a gateway, once
skelm run examples/telegram-assistant/              # activate: registers the
                                                    # Telegram source + workflow,
                                                    # then exits — the gateway owns it
```

`skelm run` activates the project on the gateway (registers the Telegram trigger
source, the Pi backend, the workflow, and the operator grant) and exits; the
gateway then long-polls Telegram and drives a turn per message. Use `skelm list`
to see it running and `skelm stop telegram-assistant` to stop it. (The directory
must be within the gateway's trusted project root; see
[activation](../../docs/reference/http.md#projects).)

Message the bot. It replies, remembers the conversation (message it again — it
has context), and the thread survives a gateway restart. Ask it to do something
that needs the shell (e.g. "what's the disk usage here?") and — because it's
granted — it runs the command and reports back. Remove the grant and the same
request is denied (`permission.denied`).

## How it works

The gateway routes each inbound Telegram message (a `queue` trigger fire) through
the [persistent workflow](../../docs/concepts/persistent-workflows.md): the
`code()` preamble enriches the message, then the terminal turn loads the session
for `agent.sessionKey(msg) = msg.chatId`, runs one agent turn through the
gateway's enforcement, persists the updated conversation, and posts the reply. See
the [recipe](../../docs/recipes/telegram-persistent-workflow.md) for the full
walkthrough.
