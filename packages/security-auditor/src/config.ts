// Default auditor configuration and config-merge helper. The shipped workflow
// package exposes these toggles via its manifest `config` block; the merge
// keeps caller overrides while filling in defaults.

import type { AuditConfig, RuleId, Severity } from './types.js'

/** Every rule the auditor ships. */
export const ALL_RULE_IDS: readonly RuleId[] = [
  'fs-write-broad',
  'network-egress-broad',
  'unrestricted-grant',
  'secret-value-in-source',
  'risky-executable-profile',
  'missing-approval-privileged',
  'manifest-permission-drift',
  'unverified-webhook-trigger',
]

/** Default config: every rule enabled, failing the audit on `high` findings. */
export const DEFAULT_AUDIT_CONFIG: AuditConfig = Object.freeze({
  failOn: 'high' satisfies Severity,
})

/** Merge a partial config over the defaults. Caller values win. */
export function resolveAuditConfig(config: AuditConfig = {}): AuditConfig {
  return {
    failOn: config.failOn ?? DEFAULT_AUDIT_CONFIG.failOn ?? 'high',
    ...(config.rules !== undefined && { rules: config.rules }),
  }
}
