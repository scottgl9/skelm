# Persistent agents

A **pipeline** is a bounded run: a trigger fires, the gateway runs its steps, the run ends. That is the right model for workflows — review a PR, triage a ticket, enrich a record. It is the wrong model for a chat bot you talk *through*, where the same conversation continues across many messages and should survive a gateway restart.

A **persistent agent** fills that gap. Its *identity* and *conversation* outlive any single trigger fire:

```ts
import { persistentAgent } from 'skelm'

export default persistentAgent({
  id: 'support-bot',
  backend: 'pi',
  system: 'You are a concise support assistant.',
  triggers: [{ kind: 'queue', sourceId: 'telegram' }],
  sessionKey: (msg) => msg.chatId, // one durable session per chat
})
```

## How it works

Each trigger fire runs **exactly one bounded, gateway-enforced, audited turn**:

```
trigger fire ─▶ load session(sessionKey) ─▶ run 1 enforced turn ─▶ save session ─▶ reply
```

1. The gateway derives a **session key** from the trigger payload via your `sessionKey` function (e.g. the Telegram `chatId`).
2. It loads the durable conversation for that key from the run store's `StateStore`, or starts a fresh one with a new stable `sessionId`.
3. It resolves permissions and runs **one** agent turn through the same enforcement path a pipeline `agent()` step uses — tools, exec, network, fs, secrets are all gated. The stable `sessionId` is threaded into the backend (`AgentRequest.sessionId`) and the agentmemory session lifecycle, so resumption-capable backends pick up where they left off.
4. It appends the turn and persists the session.
5. It returns a reply, which a queue driver's `onResult` posts back (for Telegram, as a chat message).

There is **no resident in-process loop**. Triggers drive turns, exactly like a run drives a pipeline step. This keeps the durability and audit guarantees intact: every turn is a normal, observable, recoverable unit of work, and the conversation lives in durable storage rather than process memory.

## Why this shape

- **Durable.** Conversation state is in the `StateStore` (SQLite in production), keyed by `${agentId}::${sessionKey}`. Restart the gateway and the next message continues the same thread.
- **Enforced.** A persistent agent is still subject to the [permission model](/concepts/permissions). Default-deny applies per turn. A freewheeling assistant opts into the operator-gated [unrestricted bypass](/concepts/permissions#the-unrestricted-bypass-freewheeling-agents) — it is never implicit.
- **Trigger-driven.** Any trigger can drive a turn. A `queue` trigger (Telegram, Slack, an internal queue) turns inbound messages into turns; a `cron`/`interval` trigger can drive proactive turns.

## Sessions

A session is one durable conversation. The `sessionKey` function decides the granularity:

| `sessionKey` returns | Result |
|----------------------|--------|
| the chat id | one conversation per chat (typical) |
| a constant | one shared global conversation |
| `user:${id}` | one conversation per user across channels |

Each session record holds a stable `sessionId`, the serialized conversation, a turn count, and timestamps. See `PersistentSessionRecord`, `loadSession`, and `saveSession` in `@skelm/core`.

## See also

- [Telegram persistent-agent recipe](/recipes/telegram-persistent-agent) — a full freewheeling chat bot, end to end.
- [Triggers](/guides/triggers) — how queue/cron/webhook triggers drive turns.
- [Agentmemory](/guides/agentmemory) — long-term recall across sessions.
