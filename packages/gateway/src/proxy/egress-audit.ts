/**
 * Audit event emission for network egress decisions.
 */

import type { AuditWriter } from '@skelm/core'

/**
 * Network egress audit event.
 */
export interface NetworkEgressEvent {
  event: 'network.egress'
  runId: string
  stepId: string
  host: string
  decision: 'allow' | 'deny'
  reason?: 'egress-denied' | 'not-in-allowlist' | 'unknown-token' | 'unknown'
  timestamp: string
}

/**
 * Emits a network egress audit event.
 *
 * @param auditWriter The audit writer to use
 * @param event The network egress event
 */
export async function emitEgressAudit(
  auditWriter: AuditWriter,
  event: NetworkEgressEvent,
): Promise<void> {
  await auditWriter.write({
    timestamp: event.timestamp,
    runId: event.runId,
    actor: 'egress-proxy',
    action: event.decision === 'allow' ? 'network.egress:allow' : 'network.egress:deny',
    details: {
      runId: event.runId,
      stepId: event.stepId,
      host: event.host,
      decision: event.decision,
      reason: event.reason,
    },
  })
}
