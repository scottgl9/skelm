/**
 * Audit event emission for network egress decisions.
 */

import type { AuditWriter } from '@skelm/core'

/**
 * Network egress audit event.
 */
export interface NetworkEgressEvent {
  event: 'network.egress'
  /**
   * Resolved from the proxy token (`<runId>:<stepId>`). `undefined` when the
   * request carried no token (typical of an untokened probe) or the token
   * was malformed. Downstream consumers should special-case absence rather
   * than the historical sentinel string `"unknown"`.
   */
  runId?: string
  stepId?: string
  host: string
  decision: 'allow' | 'deny'
  reason?: 'egress-denied' | 'not-in-allowlist' | 'unknown-token' | 'unknown'
  timestamp: string
  /**
   * Remote peer of the proxy connection (the agent subprocess, a probe,
   * or an unexpected lateral mover). Populated whenever the proxy can
   * read the socket's peer info. Lets an operator correlate an
   * untokened deny back to a process via `ss` / `lsof`.
   */
  source?: {
    address: string
    port: number
  }
  /**
   * True when the request carried *any* kind of `Authorization` /
   * `Proxy-Authorization` header (Basic, Bearer, anything). Distinguishes
   * "no token at all" (typical of a port-scan or misrouted client) from
   * "token sent but the proxy's store didn't recognise it" (often a
   * configuration drift between the gateway and a long-lived subprocess).
   */
  tokenPresent?: boolean
  /**
   * Cumulative count of unknown-token deny events seen since the proxy
   * started. Useful for spotting spikes in untokened probes when a
   * spiked-but-otherwise-quiet audit log is the only signal.
   * Only set on entries that themselves are unknown-token denials.
   */
  unknownTokenDenials?: number
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
    ...(event.runId !== undefined && { runId: event.runId }),
    actor: 'egress-proxy',
    action: event.decision === 'allow' ? 'network.egress:allow' : 'network.egress:deny',
    details: {
      ...(event.runId !== undefined && { runId: event.runId }),
      ...(event.stepId !== undefined && { stepId: event.stepId }),
      host: event.host,
      decision: event.decision,
      reason: event.reason,
      ...(event.source !== undefined && { source: event.source }),
      ...(event.tokenPresent !== undefined && { tokenPresent: event.tokenPresent }),
      ...(event.unknownTokenDenials !== undefined && {
        unknownTokenDenials: event.unknownTokenDenials,
      }),
    },
  })
}
