---
title: Host/Event Bridge Patterns
---

# Host/Event Bridge Patterns

Host bridges adapt external applications into skelm without baking provider policy into core. Use them when a host such as Slack, Matrix, GitHub, Telegram, or an internal ticket system needs to start a workflow and receive a send or reply action after the run completes.

The core bridge surface is intentionally small:

- `normalizeHostEvent()` turns provider payloads into a stable `NormalizedHostEvent`.
- `hostIdentityKey()`, `hostThreadKey()`, and `hostEventDedupeKey()` build deterministic keys for tenants, conversations, and deliveries.
- `createHostSendAction()` and `createHostReplyAction()` create outbound envelopes that adapters can translate into provider API calls.

## Normalize inbound events

```ts
import { normalizeHostEvent } from '@skelm/core'

const event = normalizeHostEvent({
  host: { provider: 'matrix', workspaceId: roomId },
  type: 'message.created',
  eventId: matrixEvent.event_id,
  actor: { id: matrixEvent.sender, type: 'user' },
  thread: { kind: 'room-thread', parentId: roomId, id: threadId },
  occurredAt: matrixEvent.origin_server_ts,
  payload: matrixEvent,
})
```

Pass the normalized event as the trigger payload or queue message. The gateway still owns dispatch, permissions, secrets, and audit; the bridge only shapes adapter data.

## Correlate runs and dedupe deliveries

Adapters should pass provider delivery ids through `eventId` or `dedupeKey` whenever available. If a provider lacks a delivery id, the fallback dedupe key is derived from host identity, event type, thread, and `occurredAt`. That timestamp is required for fallback keys so two undated events on the same thread cannot silently collide. Provider-supplied ids are still preferred for reliable deduplication.

`run.correlationId` defaults to the normalized thread key when a thread is present. That gives adapters a stable handle for mapping follow-up events to the same conversation without knowing skelm run ids ahead of time.

## Emit outbound actions

```ts
import { createHostReplyAction } from '@skelm/core'

const action = createHostReplyAction({
  event,
  body: { text: 'I queued the deployment review.' },
  run: { runId: run.runId, correlationId: event.run.correlationId },
})
```

Adapters translate the action envelope into provider calls. For example, a Matrix adapter would send `body.text` to `replyTo.parentId`; a GitHub adapter might post the text to an issue or PR thread. Core does not decide bot filtering, routing policy, auth, retries, or provider-specific formatting.

## Boundaries

- Host bridges do not bypass the gateway trust boundary.
- Bridge helpers do not perform network or filesystem work.
- Keep provider policy in integrations or adapters, not in `@skelm/core`.
- Store only descriptors and ids in workflow events; do not put secret tokens or raw credentials in payload metadata.
