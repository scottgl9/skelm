/**
 * Inbound mapping: an OpenClaw-style host message/event → a normalized skelm
 * trigger input the bridge submits to the gateway.
 *
 * The OpenClaw side speaks the conversation-adapter `InboundEvent` shape
 * (`@skelm/integration-sdk`). The bridge normalizes that into a flat,
 * JSON-serializable workflow input and preserves the originating channel as a
 * {@link DeliveryTarget} so the result can be routed back to where the message
 * came from — closing the inbound→run→deliver loop without losing provenance.
 */

import type { DeliveryTarget } from '@skelm/core'
import type { InboundEvent } from '@skelm/integration-sdk'

/** A normalized workflow input derived from an inbound host event. */
export interface NormalizedTriggerInput {
  /** Free-text the user sent, when any. */
  readonly text?: string
  /** Originating provider (e.g. `openclaw`, `slack`). */
  readonly provider: string
  /** Provider event id, carried for dedupe/idempotency downstream. */
  readonly eventId: string
  /** Normalized event kind. */
  readonly kind: InboundEvent['type']
  /** Channel/room/chat id the event came from. */
  readonly conversationId: string
  readonly threadId?: string
  readonly userId?: string
  /** Slash-command name for `command` events. */
  readonly command?: string
  /** Epoch ms the provider reported. */
  readonly at: number
}

/** An inbound event normalized into a trigger input plus a reply target. */
export interface NormalizedInbound {
  readonly input: NormalizedTriggerInput
  /**
   * Where a result should be delivered back: the originating conversation,
   * expressed as the canonical {@link DeliveryTarget}. Carried end-to-end so
   * audit/lineage and the final reply land on the same channel.
   */
  readonly deliveryTarget: DeliveryTarget
}

/**
 * Normalize an OpenClaw `InboundEvent` into a trigger input + reply target.
 * Pure and deterministic; no secret material flows through. The reply target's
 * `kind` is the provider so the delivery layer can pick the right adapter.
 */
export function normalizeInbound(event: InboundEvent): NormalizedInbound {
  const input: NormalizedTriggerInput = {
    provider: event.provider,
    eventId: event.eventId,
    kind: event.type,
    conversationId: event.target.conversationId,
    at: event.at,
    ...(event.text !== undefined ? { text: event.text } : {}),
    ...(event.target.threadId !== undefined ? { threadId: event.target.threadId } : {}),
    ...(event.target.userId !== undefined ? { userId: event.target.userId } : {}),
    ...(event.command !== undefined ? { command: event.command } : {}),
  }

  const metadata: Record<string, unknown> = { eventId: event.eventId }
  if (event.target.threadId !== undefined) metadata.threadId = event.target.threadId
  if (event.target.userId !== undefined) metadata.userId = event.target.userId

  return {
    input,
    deliveryTarget: {
      kind: event.provider,
      target: event.target.conversationId,
      metadata,
    },
  }
}
