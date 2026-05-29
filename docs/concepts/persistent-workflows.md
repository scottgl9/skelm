# Persistent workflows

A plain **pipeline** is a bounded run: a trigger fires, the gateway runs its steps, the run ends. That is the right model for stateless workflows — review a PR, triage a ticket, enrich a record. It is the wrong model for a chat bot you talk *through*, where the same conversation continues across many messages and should survive a gateway restart.

A **persistent workflow** fills that gap while staying inside the workflow model. Each trigger fire runs fresh **preamble** steps (`code()`, `llm()`, control flow) that enrich or transform the incoming message, then **always ends in one long-lived, session-keyed agent turn** whose *conversation* outlives any single fire:

```ts
import { code, persistentWorkflow } from 'skelm'

export default persistentWorkflow({
  id: 'support-bot',
  triggers: [{ kind: 'queue', sourceId: 'telegram' }],
  // Optional preamble — runs fresh each fire, NOT persistent.
  steps: [
    code({ id: 'prepare', run: (ctx) => ({ text: `[${ctx.input.from}] ${ctx.input.text}` }) }),
  ],
  // The persistent terminal. The workflow always ends here.
  agent: {
    backend: 'pi',
    system: 'You are a concise support assistant.',
    sessionKey: (msg) => msg.chatId, // one durable session per chat
    prompt: (ctx) => ctx.steps.prepare.text, // default: ctx.input.text
  },
})
```

The simplest persistent workflow has no preamble at all — just `id`, `triggers`, and `agent`. That is exactly a long-lived chat agent, with the preamble available the moment you need to preprocess a message.

## How it works

Each trigger fire runs the preamble steps and then **exactly one bounded, gateway-enforced, audited terminal turn**:

```
trigger fire ─▶ load session(sessionKey) ─▶ [preamble steps] ─▶ run 1 enforced turn ─▶ save session ─▶ reply
```

1. The gateway derives a **session key** from the trigger payload via your `agent.sessionKey` function (e.g. the Telegram `chatId`). It is resolved up front — session identity is *who's talking*, independent of the preamble.
2. It loads the durable conversation for that key from the run store's `StateStore`, or starts a fresh one with a new stable `sessionId`.
3. It runs the workflow as a **single Run**: the preamble steps first (each under its own declared permissions, default-deny), then the terminal agent turn through the same enforcement path a pipeline `agent()` step uses — tools, exec, network, fs, secrets all gated. The terminal `prompt` derives the user message from the full context (`ctx.input` plus preamble outputs in `ctx.steps`). The stable `sessionId` is threaded into the backend (`AgentRequest.sessionId`) and the agentmemory session lifecycle, so resumption-capable backends pick up where they left off.
4. It appends the turn and persists the session. A failed step (preamble or terminal) never persists a partial turn.
5. It returns a reply, which a queue driver's `onResult` posts back (for Telegram, as a chat message).

There is **no resident in-process loop**. Triggers drive fires, exactly like a run drives a pipeline. This keeps the durability and audit guarantees intact: every fire is a normal, observable, recoverable unit of work, and the conversation lives in durable storage rather than process memory.

## Why this shape

- **One model.** A persistent workflow *is* a workflow — preamble steps plus a terminal turn — not a separate concept bolted on beside `pipeline()`. The whole fire is one Run with one event log.
- **Durable.** Conversation state is in the `StateStore` (SQLite in production), keyed by `${workflowId}::${sessionKey}`. Restart the gateway and the next message continues the same thread.
- **Enforced.** A persistent workflow is still subject to the [permission model](/concepts/permissions). Default-deny applies per step. The terminal turn's `agent.permissions` (and its opt-in to the operator-gated [unrestricted bypass](/concepts/permissions#the-unrestricted-bypass-freewheeling-agents)) apply **only** to that turn — preamble steps carry their own permissions and stay default-deny even when the workflow id is granted the bypass.
- **Trigger-driven.** Any trigger can drive a fire. A `queue` trigger (Telegram, Slack, an internal queue) turns inbound messages into turns; a `cron`/`interval` trigger can drive proactive turns.

## Preamble steps

The preamble is the difference from a bare chat agent. It runs fresh each fire and feeds the terminal turn through `ctx.steps`:

- **`code()`** — enrich, redact, rate-limit, or reshape the inbound message; fetch context from an API.
- **`llm()`** — classify intent or summarize before the expensive agent turn.
- **control flow** (`branch`, `parallel`, …) — route or gate the message.

No preamble step may use the reserved id `'turn'` — that id belongs to the synthesized terminal turn.

## Sessions

A session is one durable conversation. The `agent.sessionKey` function decides the granularity:

| `sessionKey` returns | Result |
|----------------------|--------|
| the chat id | one conversation per chat (typical) |
| a constant | one shared global conversation |
| `user:${id}` | one conversation per user across channels |

Each session record holds a stable `sessionId`, the serialized conversation, a turn count, and timestamps. See `PersistentSessionRecord`, `loadSession`, and `saveSession` in `@skelm/core`.

## See also

- [Telegram persistent-workflow recipe](/recipes/telegram-persistent-workflow) — a full freewheeling chat bot, end to end.
- [Triggers](/guides/triggers) — how queue/cron/webhook triggers drive fires.
- [Agentmemory](/guides/agentmemory) — long-term recall across sessions.
