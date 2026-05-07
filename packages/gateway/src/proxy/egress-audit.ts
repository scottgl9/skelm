/**
 * Audit helpers for the egress proxy.
 *
 * Emits `network.egress` audit events so every outbound connection attempt
 * (allowed or denied) is visible in `skelm audit query`.
 */

import type { AuditWriter } from '@skelm/core'
import type { EgressDecision, EgressPolicy } from './egress-policy.js'

export async function writeEgressAudit(
  writer: AuditWriter,
  host: string,
  policy: EgressPolicy | undefined,
  decision: EgressDecision,
): Promise<void> {
  await writer.write({
    timestamp: new Date().toISOString(),
    ...(policy?.runId !== undefined && { runId: policy.runId }),
    actor: policy?.stepId ?? 'unknown-step',
    action: 'network.egress',
    details: {
      host,
      decision: decision.allow ? 'allow' : 'deny',
      ...(!decision.allow && { reason: decision.reason }),
    },
  })
}
