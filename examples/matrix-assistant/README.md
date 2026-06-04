# matrix-assistant

A **persistent agent** you talk to over [Matrix](https://matrix.org) — one
durable conversation per room that survives across messages and gateway
restarts. It is the [`telegram-assistant`](../telegram-assistant) example over a
different channel.

This example demonstrates three things together:

- **Persistent agent** (`persistentAgent()`) with a per-room `sessionKey`.
- **Agentmemory** wired in for long-term recall across sessions.
- The **operator-gated unrestricted bypass** — a freewheeling assistant with full
  shell/network/filesystem access.

## ⚠️ Security — read this first

`assistant.workflow.mts` sets `permissions.requestUnrestricted: true`, and
`skelm.config.ts` grants it via `defaults.unrestrictedGrants`. **Together these
give the agent full `exec` / network / filesystem access as the gateway user** —
anything it decides to run, runs.

Mitigations this example ships with, which you should keep:

1. **`MATRIX_ALLOWED_ROOM_IDS`** — only listed rooms can drive the agent. Leave
   it unset and the gateway warns loudly; an open channel means anyone who can
   join the room gets a root-ish shell on your machine.
2. **Self-message filtering** — the source drops the bot's own messages (which
   Matrix `/sync` echoes back) using the bot's user id, so it never loops on its
   own replies.
3. **Audit** — every bypassed turn writes a `permission.bypassed` entry to
   `<stateDir>/audit.jsonl` (query with `skelm audit query --action permission.bypassed`).
4. Run it on a machine / container you are willing to expose.

Remove the agent id from `unrestrictedGrants` and the bot reverts to default-deny
(its declared `agentmemory` permissions still apply) — a good way to develop the
persona before granting the bypass.

## Run

```bash
export MATRIX_HOMESERVER_URL=https://matrix.example.org
export MATRIX_ACCESS_TOKEN=...                       # bot access token
export MATRIX_USER_ID=@assistant:example.org         # the bot's own user id
export MATRIX_ALLOWED_ROOM_IDS=!yourroom:example.org # strongly recommended
# Optional: a running @skelm/agentmemory server (default http://localhost:3111)
export SKELM_AGENTMEMORY=0                            # set to disable agentmemory

skelm gateway start --foreground                     # foreground; Ctrl-C drains
```

Invite the bot to an **unencrypted** room and message it. It replies, remembers
the conversation (message it again — it has context), and the thread survives a
gateway restart. Ask it to do something that needs the shell (e.g. "what's the
disk usage here?") and — because it's granted — it runs the command and reports
back. Remove the grant and the same request is denied (`permission.denied`).

## How it works

The gateway routes each inbound Matrix message (a `queue` trigger fire) through
the [persistent workflow](../../docs/concepts/persistent-workflows.md): load the
session for `sessionKey(msg) = msg.roomId`, run one agent turn through the
gateway's enforcement, persist the updated conversation, post the reply via the
source's `onResult`. See the
[recipe](../../docs/recipes/matrix-persistent-agent.md) for the full walkthrough.

This integration speaks the raw Matrix Client-Server API and handles
**unencrypted rooms only** — `m.room.encrypted` events are skipped.
