/**
 * Outbound mapping: a {@link ToolResult} → a normalized {@link OutboundEvent}
 * delivered back to the originating channel via a {@link DeliveryTarget}.
 *
 * The bridge does not own the transport — it reshapes a gateway run/task result
 * into a conversation-adapter `OutboundEvent` and hands it to a caller-supplied
 * {@link Deliver} sink (an `@skelm/integration-sdk` adapter, the OpenClaw host,
 * a test fake). Run/task/audit references are carried into the outbound
 * `providerOptions.skelmRefs` so the reply stays correlated to its audit trail.
 */

import type { DeliveryTarget } from '@skelm/core'
import type { ConversationTarget, OutboundEvent } from '@skelm/integration-sdk'
import type { AuditRefs, ToolResult } from './tools.js'

/** A sink that delivers a normalized outbound event to its target. */
export type Deliver = (event: OutboundEvent) => Promise<void> | void

/** Turn a {@link DeliveryTarget} back into a conversation-adapter target. */
export function targetToConversation(target: DeliveryTarget): ConversationTarget {
  const meta = target.metadata ?? {}
  const threadId = typeof meta.threadId === 'string' ? meta.threadId : undefined
  const userId = typeof meta.userId === 'string' ? meta.userId : undefined
  return {
    conversationId: target.target,
    ...(threadId !== undefined ? { threadId } : {}),
    ...(userId !== undefined ? { userId } : {}),
  }
}

export interface DeliveryMappingOptions {
  /** Human-readable text for the reply; defaults to a short summary line. */
  readonly text?: string
}

/**
 * Map a tool result + its delivery target into an outbound event. The audit
 * references travel in `providerOptions.skelmRefs` so a downstream adapter (and
 * its audit logging) can keep the reply tied to the run/task it answers.
 */
export function resultToOutbound(
  result: ToolResult,
  target: DeliveryTarget,
  opts: DeliveryMappingOptions = {},
): OutboundEvent {
  const refs: AuditRefs = result.refs
  const text =
    opts.text ??
    (result.refs.runId !== undefined
      ? `Workflow run ${result.refs.runId} ${result.ok ? 'completed' : 'failed'}.`
      : result.refs.taskId !== undefined
        ? `Task ${result.refs.taskId} dispatched.`
        : result.ok
          ? 'Done.'
          : 'Failed.')
  return {
    target: targetToConversation(target),
    text,
    providerOptions: { skelmRefs: refs },
  }
}

/**
 * Deliver a tool result back to the originating channel and return the audit
 * references that were carried through. Closes the run→deliver half of the
 * loop; the sink is responsible for the actual send.
 */
export async function deliverResult(
  deliver: Deliver,
  result: ToolResult,
  target: DeliveryTarget,
  opts: DeliveryMappingOptions = {},
): Promise<AuditRefs> {
  await deliver(resultToOutbound(result, target, opts))
  return result.refs
}
